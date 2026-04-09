# Migration plan: `GeneratedAudio` + native PCM sink

High-level plan to move from **returning full PCM as `number[]` over the TurboModule bridge** to a **native-held buffer (“sink”)** with **metadata-first** `GeneratedAudio` and an **explicit `await audio.getSamples()`** for power users who need JavaScript-side PCM.

Use this document to split work into sub-plans and implement them incrementally.

---

## 1. Context and goals

### Problem

- `generateTts` / `generateSpeech` currently return **large `samples: number[]`**, built **element-by-element** on the native side and marshalled across the React Native bridge.
- For long utterances (hundreds of thousands to millions of samples), this causes **O(n) bridge overhead**, **high memory use in JS**, and **poor UX**.

### Goals

- **Default path:** no bulk PCM crossing the bridge for every batch synthesis.
- **Public SDK:** clear, safe API; avoid mandatory temp files for the common case; avoid fragile patterns (e.g. `UnsafeMixed` as the primary contract).
- **Power users:** optional **one-shot** transfer of PCM into JS as **`Float32Array`** (or `ArrayBuffer` view), via **hand-written native code** (JSI `createArrayBuffer` + `memcpy` on iOS; Android equivalent on the TurboModule/JSI runtime), **not** relying on Codegen-first-class `ArrayBuffer` types (see discussion: RN 0.83 / 0.85 **Codegen does not** expose `ArrayBuffer` in TurboModule specs).

### Non-goals (for this phase)

- Replacing **streaming** chunk events (`TtsStreamChunk.samples`) in one go; treat as a **follow-up** or separate sub-plan if chunk payloads still use `number[]`.
- Relying on a **React Native upgrade** solely to get Codegen `ArrayBuffer` support — **not** available in current Codegen types.

---

## 2. Target architecture (summary)

| Aspect | Today | Target |
|--------|--------|--------|
| `GeneratedAudio` | `samples: number[]`, `sampleRate` | **No** `samples` array on the object by default. **Metadata** in JS: e.g. `sampleRate`, `numSamples` (and any other stable fields you need). |
| Where PCM lives | Copied into JS as `number[]` | **Last successful batch synthesis** for an engine instance is stored in a **native sink** (per instance + generation). |
| Getting PCM in JS | `audio.samples` | **`await audio.getSamples(): Promise<Float32Array>`** (or equivalent name), which **calls native once** to copy from sink into a JS `Float32Array` / `ArrayBuffer`. |
| `saveAudio`, alignment, etc. | Often receive `samples` from JS | **Prefer** native APIs that read **from the same sink** (or from `instanceId` + generation), so **large** PCM does not round-trip through JS when not needed. |

### Design rules

1. **`getSamples()` is async** — native bridge / JSI work is not exposed as a synchronous property getter.
2. **Binding** — each `GeneratedAudio` (or its engine) carries enough **identity** (`instanceId`, optional **generation** / monotonic id) so native code knows **which** buffer to materialize and can **invalidate** stale handles after a new `generateSpeech`.
3. **Idempotency** — optional: second `await getSamples()` may return a **cached** `Float32Array` in JS after the first copy, or **re-copy** from native; pick one behavior and document it.

---

## 3. Workstreams (sub-plan topics)

### 3.1 Native sink — data model and lifecycle

- Define **native storage** for “last batch PCM” per **TTS instance** (existing `instanceId`):
  - Float **mono** samples as produced today, **sample rate**, **frame count** / **generation id**.
- **On each successful `generateTts`:** replace or update sink contents; **bump generation** so old `GeneratedAudio`/`getSamples` can reject or error if stale.
- **On `destroy()` / unload:** release sink memory and clear handles.
- **Threading:** align with existing init/generation threads (Android: batch service / executor; iOS: wrapper store) — ensure **no races** between synthesis, `getSamples`, and `destroy`.

**Deliverable:** internal API on Android and iOS that can **copy out** or **expose** PCM for a given `(instanceId, generation)` without involving JS arrays in the hot path.

**Detailed sub-plan:** [tts-native-sink-subplan-01.md](./tts-native-sink-subplan-01.md)

---

### 3.2 TurboModule / native bridge surface

- **Change `generateTts` (and `generateTtsWithTimestamps` if applicable)** return payload to **omit** large `samples` arrays from the `WritableMap` / NSDictionary — only **metadata** (`sampleRate`, `numSamples`, …).
- **Add** a dedicated native method, e.g. **`getTtsSamplesForGeneration(instanceId, generation)`** (exact names TBD), that:
  - Returns **only** when the generation is still valid;
  - Builds **one** `ArrayBuffer` / `Float32Array` in JS via **JSI** (hand-written in **iOS** `.mm` / **Android** Kotlin/C++ as required by your stack), **not** via Codegen-typed `ArrayBuffer` in the spec.
- **Spec file (`NativeSherpaOnnx.ts`):** keep **Codegen-friendly** types for the new method (e.g. `Promise<{ base64?: never }>` or split return types) — **avoid** pretending Codegen supports `ArrayBuffer`; implement the **JSI return path** in the **native implementation** of the module where the TurboModule spec is implemented.

**Deliverable:** batch synthesis **no longer** allocates `WritableArray` of doubles for every sample in `generateTts`.

**Detailed sub-plan:** [tts-native-sink-subplan-02.md](./tts-native-sink-subplan-02.md)

---

### 3.3 TypeScript — `GeneratedAudio` and engine factory

- Update **`src/tts/types.ts`**: `GeneratedAudio` **no longer** has `samples: number[]`; add **`numSamples`** (or `durationMs`), keep **`sampleRate`**, and add **`getSamples(): Promise<Float32Array>`**.
- **`generateSpeech`** in **`src/tts/index.ts`** should return an object that:
  - Carries **metadata** from native;
  - Closes over **`instanceId`** + **generation** (or receives them from native in the metadata);
  - Implements **`getSamples()`** by calling the **new TurboModule** method (or a thin internal helper).
- **`GeneratedAudioWithTimestamps`:** same base shape; **`generateSpeechWithTimestamps`** should use **`await getSamples()`** (etc.) **only in `src/tts/**`** when calling the **existing** **`alignTextToAudio`** API — **Sub-plan 03 does not change `src/alignment/**`** (see [Sub-plan 03](./tts-native-sink-subplan-03.md)). Sink-based / path-based alignment belongs in **§3.4+** and a future alignment sub-plan.

**Deliverable:** `const audio = await tts.generateSpeech(...); await audio.getSamples()` works; `audio.sampleRate` / `audio.numSamples` work without transferring PCM.

**Detailed sub-plan:** [tts-native-sink-subplan-03.md](./tts-native-sink-subplan-03.md)

---

### 3.4 Dependent features

- **`saveAudio` / `saveTtsAudio`:** prefer a path that **reads PCM from the native sink** (instance + generation) **inside native**, given only **small** arguments from JS (paths, format, options). Fall back to **materialized** `Float32Array` only if you keep a legacy path.
- **`alignTextToAudio` / `generateSpeechWithTimestamps`:** eventual goal is **alignment-from-sink** / **from-path** / **from-PCM** with **no** huge **`number[]`**. For TTS sink integration, use a user-facing convenience API that takes **`GeneratedAudio`** directly (not raw `instanceId` + `generation`) so callers stay on public types. No extra low-level public variant is required for this plan.
- **Estimated mode integration choice:** implement **Option A** explicitly — TTS exposes timeline data, and alignment runs via standalone alignment entry points (decoupled orchestration), instead of adding a monolithic `generateTtsWithTimestampsAndAlign` call.
- **`src/tts/tempAudio.ts`**, **`src/alignment/tempAudio.ts`**, **`textSegments`**: update any **“same shape as GeneratedAudio”** assumptions.
- **Streaming (`TtsStreamChunk`):** optional follow-up; chunks may still be large — consider **chunked binary** or **smaller** payloads in a separate sub-plan.

**Deliverable:** no **required** large `number[]` on the **default** offline TTS + save + alignment flows.

**Detailed sub-plan:** [tts-native-sink-subplan-04.md](./tts-native-sink-subplan-04.md)
  
**Streaming follow-up plan:** [tts-streaming-performance-migration.md](./tts-streaming-performance-migration.md)

---

### 3.5 Documentation and migration

- **`docs/tts-offline.md`**, **`docs/tts-streaming.md`**, **`docs/migration.md`**, **`CHANGELOG.md`**: breaking change section — **remove** `samples` from immediate return; add **`getSamples()`** and **sink** semantics; **migration** snippet for apps that used `audio.samples`.
- **README** / **public exports** in `src/tts/index.ts` — re-export types.

**Deliverable:** consumers can migrate without guessing.

**Detailed sub-plan:** [tts-native-sink-subplan-05.md](./tts-native-sink-subplan-05.md)

---

### 3.6 Testing and example app

- **Host / unit tests** where applicable (mostly TS + native integration tests).
- **Example app** (`example/`): replace `audio.samples` usage with **`await audio.getSamples()`** or sink-based APIs.
- **Manual QA:** long text generation, memory, **destroy** after `getSamples`, **double** `generateSpeech` invalidates old generation.

**Deliverable:** confidence in lifecycle and no regressions on Android + iOS.

**Detailed sub-plan:** [tts-native-sink-subplan-05.md](./tts-native-sink-subplan-05.md)

---

## 4. Risks and edge cases

| Risk | Mitigation |
|------|------------|
| **Stale `getSamples()`** after a new `generateSpeech` | **Generation id** + clear **error** or throw. |
| **Memory** on native sink | **One** “last generation” per instance or **bounded** policy; document. |
| **Codegen vs JSI** | **Do not** block on Codegen `ArrayBuffer`; implement **materialization** in native module implementation. |
| **Hermes / Float32Array** | Validate **byte length** = `numSamples * 4` (mono float). |
| **Parity Android / iOS** | Same **metadata** and **getSamples** semantics. |

---

## 5. Suggested order of sub-plans

1. **Native sink + lifecycle** (3.1) — foundation.
2. **Narrow generateTts return** + **metadata-only** to JS (3.2 + partial 3.3 types).
3. **JSI `getSamples` / TurboModule method** (3.2 + 3.3 implementation).
4. **Refactor `saveAudio` / alignment** to prefer sink (3.4), with TTS alignment convenience based on `GeneratedAudio` and estimated-mode **Option A**.
5. **Docs + migration + CHANGELOG** (3.5).
6. **Example + tests** (3.6).
7. **Optional:** streaming chunk binary (separate doc).

---

## 6. References (codebase)

| Area | Location |
|------|----------|
| Sub-plan 01 (native sink only) | [docs/tts-native-sink-subplan-01.md](./tts-native-sink-subplan-01.md) |
| Sub-plan 02 (metadata-only `generateTts` + `getTtsSamples`) | [docs/tts-native-sink-subplan-02.md](./tts-native-sink-subplan-02.md) |
| Sub-plan 03 (`GeneratedAudio` + `getSamples()` TS layer) | [docs/tts-native-sink-subplan-03.md](./tts-native-sink-subplan-03.md) |
| Sub-plan 04 (sink-native save, temp audio, alignment consumers) | [docs/tts-native-sink-subplan-04.md](./tts-native-sink-subplan-04.md) |
| Sub-plan 05 (docs, migration, example, tests) | [docs/tts-native-sink-subplan-05.md](./tts-native-sink-subplan-05.md) |
| `GeneratedAudio` | `src/tts/types.ts` |
| `generateSpeech` / `generateTts` | `src/tts/index.ts`, `NativeSherpaOnnx.ts` |
| Android batch return | `android/.../TtsBatchGenerationService.kt` |
| iOS batch TTS | `ios/tts/bridge/SherpaOnnx+TTSBatch.mm`, `ios/tts/native/sherpa-onnx-tts-wrapper.mm` |
| Alignment using `generated.samples` | `src/tts/index.ts` (`generateSpeechWithTimestamps`) |

---

*This document is a planning aid; implementation details (exact method names, error codes, caching) may differ per sub-plan.*
