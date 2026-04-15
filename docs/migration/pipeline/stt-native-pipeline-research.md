# STT internals & native audio pipeline — research notes (IST / SOLL)

Working document to collect **current behavior**, **target principles**, and **design ideas** before a high-level implementation plan. This is not a committed roadmap; it feeds the major-release rework of STT and cross-feature native integration.

Related:

- [tts-generated-audio-native-sink-migration.md](./tts-generated-audio-native-sink-migration.md) — TTS output sink, `generation`, and native consumers (e.g. alignment) without bulk PCM through JS.
- [stt-native-pipeline-spec-implementation-plan.md](./stt-native-pipeline-spec-implementation-plan.md) — concrete TurboModule signatures, unified error codes, slice semantics, and full test matrix for implementation.

---

## Release and API philosophy

- **Breaking changes are expected and welcome** for this major cycle. The current public surface and internal split are not the long-term shape we want.
- **Public SDK:** we do not control app use cases; audio and text **may be very long**. Design for **worst-case size and latency**, not only typical short clips.
- **Performance over backward compatibility** when choosing between keeping an old bridge shape and introducing handles, native buffers, or new method names.

---

## Non‑negotiables (SOLL principles)

1. **Large payloads by reference (mandatory)**  
   Recognition **results** (text, token arrays, timestamp arrays, durations, etc.) must not be the **default** full marshal across the bridge for long utterances. The direction is **native-retained results** keyed by **stable identifiers** (`instanceId` + session / generation / `resultId`), with **small metadata** or **incremental / lazy** readout APIs where needed.  
   *Rationale:* same class of problem as TTS PCM — O(n) bridge traffic and JS memory for unbounded n.  
   *Scope:* this targets **offline** batch transcription and **heavy** streaming outcomes (e.g. **endpoint / finalized segment**) — not every **partial** hypothesis on every decode tick (see **Decision: Native retention** and **Decision: Offline vs streaming STT**). **Materialization** uses **discrete lazy getters** — see **Decision: Offline STT result materialization** (no masked bulk API).

2. **Multi-stage pipelines stay on native (mandatory where applicable)**  
   Chains such as **VAD → Enhancement → STT → Alignment** must be composable **without shipping full PCM through JavaScript** between stages. Intermediate audio should live in **native buffers or sinks** (or durable paths when file-based is explicitly chosen), with stages addressed by **IDs** known to native code.  
   **Analog:** today’s **TTS → Alignment** path that can operate from the **native batch sink** (`alignTextToTtsSink` and friends) instead of JS PCM round-trip.

3. **Cross-platform JS contract**  
   For the same TurboModule / public JS API call, **Android and iOS must return the same conceptual type** (e.g. both a structured object with the same keys, or both a string where appropriate). Avoid situations where **Android returns a string and iOS returns an object** for the same method unless the difference is explicitly documented as a **temporary** exception.  
   **Exceptions** are acceptable when a platform **requires** a different native API for performance or OS constraints — document the exception, minimize surface area, and normalize at the JS facade if possible.

4. **Native layer parity (goal)**  
   Prefer **the same concepts on both platforms** (instance id, sink / buffer id, decode session, result handle, **same JS return shapes**). The **implementation language may differ** per platform when that matches existing SDK patterns (see **Decision** below).

---

## Decision: Android STT — **Kotlin sink + existing Java/Kotlin API** (recorded)

**Status:** agreed direction for the major STT rework (no second C++ STT stack on Android for parity with iOS).

**Context:** The project previously moved **away** from the sherpa-onnx **C API** toward the **official Kotlin/Java bindings** because of complexity and maintenance cost. **TTS on Android** already uses this pattern: a **Kotlin-side batch sink** ([`BatchPcmSink`](../../android/src/main/java/com/sherpaonnx/tts/core/TtsEngineModels.kt)) plus `OfflineTts`, **`generation`**, and native consumers (e.g. alignment) **without** shipping bulk PCM through JS by default. **iOS TTS** implements the **same idea** in **C++** (`sink` + generation in `SherpaOnnx+TTSBatch.mm`).

**Choice for STT:**

- **Android:** Implement **input-side** buffers / sinks and **result-by-reference** in **Kotlin**, feeding the existing **`OfflineRecognizer`** / **`OfflineStream`** (same stack as today’s `SherpaOnnxSttHelper`). No requirement to reintroduce a full duplicate **C++ `SttWrapper`** path on Android solely to match iOS line-for-line.
- **iOS:** Keep **C++ `SttWrapper`** (and extend it with the same **conceptual** sink/handle model: buffer ids, retained results, etc.).
- **JS / TurboModule:** One **stable contract** for both platforms (objects with the same keys, handles/ids, not divergent types per OS).

**Acceptable tradeoff:** Two native codebases (Kotlin vs C++), **one product semantics** and **one JS API**. Unifying everything in C++ on Android was **explicitly deprioritized** in favor of team familiarity, avoiding JNI-heavy duplication of sherpa wrapper logic, and consistency with **TTS’s proven Android shape**.

---

## Decision: PCM transport — **fully native default**; **optional** JS materialization for power users (recorded)

**Status:** agreed for STT (aligned with TTS product direction: sink-first, pipeline-first).

**Primary path (SDK default):**

- **No bulk raw audio over the React Native bridge** for normal flows. Pipelines (**VAD → Enhancement → STT → Alignment**, etc.) operate on **native buffers / sinks / durable paths**, keyed by **stable IDs** shared across native modules.
- **`number[]` (or equivalent per-element bridge arrays) is not acceptable** as the default or primary transport for PCM — same rejection as for large recognition payloads in principle.

**Secondary path (explicit, power user / exceptional):**

- Offer **optional** APIs to **materialize** float PCM in JS when apps truly need it (**TTS** `getSamples` / native `getTtsSamples`, and any **STT** opt-in “pull buffer samples” escapes). These are **non-default** escape hatches only.
- **Recorded implementation target (same release wave as STT rework + TTS cleanup):** deliver bulk float samples as **`Float32Array`** backed by a **single JSI / native bulk copy** into an **`ArrayBuffer`** view — **not** element-wise **`number[]`** over the TurboModule bridge. See [tts-generated-audio-native-sink-migration.md](./tts-generated-audio-native-sink-migration.md) (already describes `getSamples(): Promise<Float32Array>` + hand-written JSI path where Codegen lacks `ArrayBuffer`).

**Ranked preference for PCM when JS must be involved at all:**

1. **Fully native feed** — no PCM through JS (best performance, target for pipelines).
2. **JSI + `ArrayBuffer` / `Float32Array`** — **mandatory target** for **opt-in** “pull to JS” **bulk** PCM (STT + TTS); one memcpy-style copy, not per-element arrays.
3. **`number[]`** — **rejected** for **bulk** PCM on the bridge in new work; remove or replace legacy paths (e.g. current `getTtsSamples` → `number[]`) as part of the same migration.

---

## Decision: Native retention — **single active slot per engine (TTS parity; no LRU / ring)**

**Status:** agreed for the STT rework (same **product semantics** as offline TTS today).

**Intent:** STT follows the same **lifetime model** as TTS’s native batch sink: **one** retained native payload per logical engine / session for the “current” operation (input buffer and/or recognition result store — exact handles TBD), **replaced** when the next relevant operation succeeds on **that** instance. **No** implicit **LRU**, **ring buffer**, or **N-slot** multi-generation retention in RAM.

**Escapes (mirrors TTS):**

- Explicit **materialization** (e.g. read text/tokens to JS, export to file) **before** starting the next operation that would replace the slot on the same instance.
- **Multiple instances** (`instanceId`s / engines) when the app truly needs two concurrent native retainers.

**Rationale:** bounded memory, simple **stale** semantics after replace, no hidden native heap growth; users who need history use explicit persistence or extra engines — same tradeoff as TTS `getSamples` / `saveAudioFromGeneration` / second `createTTS`.

**TTS analog (recorded):** **`createTTS`** keeps **one** native **batch** PCM slot + **`generation`** (random access via `getTtsSamples` / save / playback only for the **current** generation). **`createStreamingTTS`** does **not** use that same model for routine output: audio arrives as **incremental chunks / events** (e.g. `requestId`, base64 PCM per chunk) — **push / ephemeral** consumption, not a multi-generation LRU of full buffers. STT mirrors this split.

**How STT applies (recorded):**

| Path | Native “big” retention | Partials / stream |
|------|-------------------------|-------------------|
| **Offline** (`createSTT`) | **One** active **full** result slot (or equivalent `resultId`) for the last completed `transcribe*` / buffer decode — **same philosophy as TTS batch**; stale when replaced by the next job on that instance. | N/A |
| **Streaming** (`createStreamingSTT`) | At most **one** reference-style slot for the **last finalized segment** (endpoint) **if** large token/timestamp vectors must stay native for pipelines — optional; short finals may still marshal in one shot when acceptable. | **Partial** hypotheses: **light / ephemeral** (e.g. text-first or small payloads over `getResult` / events). **Do not** natively retain **N** partial result snapshots with handles — that would recreate LRU / hidden growth and fight this decision. Internal sherpa **online** state is implementation detail, not a public “history” API. |

**Pipeline:** First-class **VAD → Enhancement → STT** buffers target **offline** ingest; **online** attach later with explicit typed registry entries (chunk / stream attachment), **not** by inventing a partial-result handle ring.

---

## Decision: Offline vs streaming STT — **two subsystems (TTS parity)** (recorded)

**Status:** agreed — **analogous to TTS** (`createTTS` vs `createStreamingTTS`).

**Public API / naming**

- **Offline (batch):** `createSTT()`, native instances keyed like `stt_*` (current JS pattern), backed by **`OfflineRecognizer`** / **`OfflineStream`** for file or native-buffer ingest.
- **Streaming (online):** `createStreamingSTT()`, instances keyed like `streaming_stt_*`, backed by **`OnlineRecognizer`** (and per-chunk / per-stream APIs), separate types and TurboModule entry points from offline.

**Rationale**

- **Different stack and lifecycle** in sherpa-onnx (offline one-shot decode vs online incremental decoding); merging into one factory would create a wide, easy-to-misuse surface.
- **Different model-type sets** and detection mapping (already reflected in JS: offline vs online `modelType`).
- **ID hygiene:** separate `instanceId` prefixes avoid collisions in native registries and keep logs/support tickets unambiguous — same reason **`streaming_tts_*`** exists beside **`tts_*`**.

**Retention (recorded):** Public split matches **TTS batch vs TTS streaming** (see table under **Decision: Native retention**). **Streaming** prioritizes **incremental** partials without **large** native-by-reference retention per tick; **offline** uses the **single-slot full result** model. When streaming uses a **by-reference** slot for the **last finalized segment**, reuse the **same discrete getters** and **`resultId`** semantics as offline (see **Decision: Offline STT result materialization** below).

---

## Decision: Native buffer / pipeline registry — **shared registry, typed handles, phased rollout** (recorded)

**Status:** agreed.

**Goal:** Compose **VAD → Enhancement → STT → Alignment** on **native** audio handles with **one shared buffer-ID contract** (see also pre‑implementation item **5**), while keeping **two public STT entry points** (`createSTT` vs `createStreamingSTT`).

**Design**

- **Single internal registry** (or equivalent central map) for **native audio payloads** passed between stages — **not** separate ad-hoc id schemes per feature.
- **Typed handles:** each id denotes **what** it refers to (e.g. `offlinePcmBuffer`, later `streamingAttachment` / stream-feed binding). Validators reject nonsensical combinations (offline-only consumer + wrong kind).
- **Public APIs stay split:** registry is an **implementation** concern; apps still use **`SttEngine`** vs **`StreamingSttEngine`** without a merged “super factory”.

**Phased rollout (recorded)**

1. **Phase 1 — offline pipeline:** First-class path is **buffer IDs** produced/consumed by VAD / Enhancement / **offline** STT / Alignment (`transcribeFromBuffer`, file → internal `bufferId`, etc.).
2. **Phase 2 — streaming attachment:** Extend the **same** registry with a **streaming-oriented** handle kind (e.g. live feed or enhanced segment feeding **online** decode). **Asymmetric** is OK: not every offline helper applies to online; types make that explicit.

**Rationale:** avoids duplicate buffer ecosystems, matches performance goals, and keeps **online** and **offline** subsystems **separate at the JS boundary** while sharing **one native id story** under the hood.

---

## Decision: Offline STT result materialization — **discrete lazy getters (no masked bulk)** (recorded)

**Status:** agreed.

**Pattern:** After a successful **`transcribe*`** (or native-buffer equivalent), the default bridge return is **small metadata only** — e.g. **`resultId`** (monotonic integer or opaque handle per `instanceId`), **`sampleRate`**, **`numTokens`** / text **length** hints as useful scalars — **not** the full recognition payload. Large columns stay in the **native result slot** until the app calls a **dedicated** getter (same **single-slot** lifetime as **Decision: Native retention**; older `resultId` → **stale**).

**Explicit TurboModule / facade getters (recorded — one concern per call; Android, iOS, and JS must align):**

| Getter | Returns | Notes |
|--------|---------|--------|
| **`getSttResultText`** | `string` | Full transcript for that `resultId`. |
| **`getSttResultTokens`** | `string[]` | May support optional **`start`** / **`maxCount`** slice parameters on the native/API boundary to cap very long lists (optional spec detail — not a bulk “field mask”). |
| **`getSttResultTimestamps`** | `number[]` | Parallel to tokens where applicable; same optional slice params as tokens if implemented. |
| **`getSttResultDurations`** | `number[]` | TDT / model-dependent durations; same optional slice params if implemented. |
| **`getSttResultLang`** | `string` | Model-dependent. |
| **`getSttResultEmotion`** | `string` | Model-dependent (e.g. SenseVoice). |
| **`getSttResultEvent`** | `string` | Model-dependent. |

Each getter takes (at minimum) **`instanceId`** and **`resultId`** (+ slice args only where noted). Exact TurboModule signatures (Promise vs sync, error codes) are implementation work.

**Stale behavior:** Reject when **`resultId`** is not the **current** retained result for that instance (mirror **`TTS_STALE_GENERATION`**: clear user-facing message that a newer transcribe replaced the slot; point to docs).

**Explicit non-goals (recorded):**

- **No** masked / bitmap **bulk** API — e.g. not `getSttResult({ fields: ['text', 'tokens'] })`, not `getSttResultBundle`, not a single “materialize everything” switch driven by field masks.
- Apps needing several columns issue **several calls**; cost is **transparent** and implementations stay **simple** across Kotlin + C++.

**TTS analogy:** Batch TTS exposes **one** heavy column (PCM) via **`getTtsSamples`**. Offline STT exposes **several** potentially large columns via **separate** getters instead of one omnibus object on **`transcribe*`**.

**Streaming:** Partial hypotheses stay **light** per **Decision: Native retention**. For a **finalized** segment held natively by reference, **reuse these getter names** and **`resultId`** semantics where applicable.

---

## Current state (IST) — offline STT

### Factual pipeline

- Per **`instanceId`**: an **`OfflineRecognizer`** (sherpa-onnx).
- Per **transcribe call**: an **`OfflineStream`**: **float PCM** → **`AcceptWaveform` → `Decode` → `GetResult`**.

So the recognizer always consumes **PCM as float** internally — suitable for a future **native input buffer / sink** that feeds the same API without exposing samples to JS.

### Platform split

| Aspect | Android | iOS |
|--------|---------|-----|
| Transcribe implementation | **`SherpaOnnxSttHelper.kt`**: `WaveReader` + Kotlin `OfflineRecognizer` / `OfflineStream` | **`SherpaOnnx+STT.mm`** → C++ **`SttWrapper`** (CXX API) |
| `transcribeFile` | Path over bridge; WAV read and decode in **Kotlin** | Path over bridge; **C++** `ReadWave` + decode |
| `transcribeSamples` | **`ReadableArray`** → per-element read to **`FloatArray`** in Kotlin — **O(n) bridge elements** | **`NSArray<NSNumber *>`** → **`vector<float>`** — same cost class |

**`transcribeFile`** is already **cheap on the bridge** (mostly a path string). **`transcribeSamples`** is the **high-cost** path for long audio.

### Return path today

- Full **`SttRecognitionResult`** is always serialized to JS: text, tokens, timestamps, durations, lang, emotion, event (e.g. `resultToWritableMap` on Android).  
- This does not scale for **very long** outputs without a **by-reference** model.

---

## Target directions (ideas for later planning)

- **Input sink / buffer IDs (mirror of TTS output sink):** accumulate or capture PCM **only natively**, then **`transcribeFromBuffer(instanceId, bufferId)`** (or feed chunks natively). Eliminates bulk **`transcribeSamples`** from JS for long input.
- **Result store:** **`transcribe*` returns** small metadata including **`resultId`**; large vectors stay native until **discrete lazy getters** (**Decision: Offline STT result materialization**) — **no** masked bulk getter.
- **File-based path:** keep **path-first** fast path; ensure **alignment** and others can consume **the same path** or **same native buffer id** without re-exporting PCM to JS.
- **Composable pipeline:** explicit native **graph** or **ordered native calls** sharing one buffer registry (VAD trims / marks → enhancement writes new buffer id → STT reads → alignment reads audio + text by id).

---

## Open questions (for high-level plan phase)

*All items below are **resolved** at philosophy / architecture level; remaining work is **spec + implementation** (TurboModule shapes, exact method names, tests).*

Concrete next-step spec details now live in [stt-native-pipeline-spec-implementation-plan.md](./stt-native-pipeline-spec-implementation-plan.md).

- ~~Single **C++** layer on Android vs **Kotlin** sink + Java API~~ — **Resolved:** Kotlin sink + existing recognizer API on Android; see **Decision** section above.
- ~~**TurboModule / Codegen** shapes for **binary PCM**: fully native vs `ArrayBuffer`~~ — **Resolved for product intent:** **Fully native** is the **default** for STT (and pipelines); **JSI / `ArrayBuffer` / `Float32Array`** only for **explicit optional** “get samples / PCM in JS” methods for power users — see **Decision: PCM transport** section above. Exact TurboModule signatures remain to be specified in the implementation plan.
- ~~**Session lifetime / multi-buffer retention:**~~ **Resolved:** **single active slot** per instance, **no LRU / ring** — aligned with TTS; optional explicit **`release*`** for clearing native state where useful. Apps persist via materialization or a second engine, same class of escape as TTS.
- ~~**Streaming (online) STT:** buffers vs offline / naming~~ — **Resolved:** **Two public subsystems** (offline vs `createStreamingSTT`), **separate `instanceId` namespaces** — TTS analog; internal registry may use typed handles across both without merging JS types. See **Decision: Offline vs streaming STT** above.

---

## Pre‑implementation review — risks and inconsistencies

This section records **gaps or tensions** spotted when re-reading the full investigation **before** coding. None of these reverse the recorded decisions; they are **planning hazards**.

1. ~~**Single-slot wording vs streaming partials**~~ — **Specified** in **Decision: Native retention** (TTS analog + table): offline = one full `resultId` slot; streaming = **ephemeral partials**, optional **single** native slot only for **last finalized segment** when large vectors must stay native — **no** multi-snapshot partial LRU. Remaining work: exact API names and when finals stay compact vs by-reference.

2. ~~**“Result by reference” granularity**~~ — **Specified** in **Decision: Offline STT result materialization**: seven **discrete** getters (`getSttResultText`, `getSttResultTokens`, `getSttResultTimestamps`, `getSttResultDurations`, `getSttResultLang`, `getSttResultEmotion`, `getSttResultEvent`); optional **slice** params only on array getters; **no** masked bulk API. Remaining work: TurboModule signatures, stale error codes, slice param finalization.

3. ~~**Android Kotlin vs iOS C++ duplication**~~ — **Accepted with guardrails**.  
   Two native implementations are expected. **Immediate action:** add **1–2 core parity tests now** (critical path only), with broader parity suite in a dedicated follow-up branch. Minimum now: one stale-slot behavior test and one cross-platform contract-shape test for by-reference result getters.

4. ~~**Pipeline buffer registry vs two STT subsystems**~~ — **Specified** in **Decision: Native buffer / pipeline registry**: **one shared native registry** with **typed handles**; **Phase 1** offline buffer pipeline; **Phase 2** streaming attachment kind — public STT APIs remain **two subsystems**.

5. ~~**Alignment and enhancement coupling**~~ — **Resolved:** use **one shared buffer-id scheme** and shared sample-rate metadata contract across STT, Alignment, and Enhancement entry points.  
   No feature-specific parallel id namespace for the same audio payload class.

6. ~~**Migration / breaking surface**~~ — **Resolved:** ship as a **public 1.0.0 major** with breaking changes allowed.  
   No compatibility/deprecation shims are required for superseded STT APIs in this rework branch.

7. ~~**`transcribeFile` remains “cheap”**~~ — **Resolved direction:** file input is ingested into an **internal native buffer** with its own **bufferId** (path as source, buffer as execution primitive).  
   This keeps path UX simple while unifying downstream handling and pipeline composition on ids.

8. ~~**Power-user PCM / bridge numeric arrays**~~ — **Specified** (**Decision: PCM transport**): **STT** and **TTS** **bulk** float PCM materialization to JS moves to **`Float32Array` / JSI-backed `ArrayBuffer`** in the **same** implementation wave; **`number[]`** is **not** the target for bulk PCM (replace **TTS** `getTtsSamples` / `getSamples` bridge shape accordingly).  
   **Recognition metadata** (`timestamps`, `durations`, token lists) remains a **separate** bridge-cost class from megabyte-scale PCM; may still use **`number[]` / `string[]`** initially where size is acceptable; revisit with JSI later if needed.

9. ~~**Open docs vs this file**~~ — **Scoped:** maintain migration guidance in **`migration.md`** during implementation; final **`stt-offline.md`** rewrite happens after the rework stabilizes.

---

## Changelog of this document

- **Added:** link to the concrete implementation artifact [stt-native-pipeline-spec-implementation-plan.md](./stt-native-pipeline-spec-implementation-plan.md) (TurboModule signatures, error-code contract, slice semantics, and test matrix).
- **Added:** initial IST/SOLL capture, parity and performance principles, pipeline vision (VAD → Enhancement → STT → Alignment), mandatory result-by-reference stance for SDK-scale content.
- **Added:** recorded **Decision** — Android STT follows **Kotlin sink + OfflineRecognizer** (mirror TTS `BatchPcmSink` pattern); iOS stays **C++**; unified JS contract. Open question on C++ vs Android Kotlin **closed**.
- **Added:** recorded **Decision** — **Fully native** PCM for default STT / pipeline; **`number[]` rejected** for bulk audio; optional power-user materialization to JS (TTS `getTtsSamples` pattern); **JSI/`ArrayBuffer` ranked** only for those opt-in paths.
- **Added:** recorded **Decision** — STT **retention** matches TTS: **one active native slot** per engine instance **without** LRU / ring / multi-slot RAM; same persistence / multi-instance escapes.
- **Updated:** open question on session lifetime / LRU **closed** in favor of TTS-parity single-slot semantics.
- **Added:** **scope note** under retention — single-slot vs **streaming partials** / internal online state.
- **Added:** recorded **Decision** — **offline vs streaming STT** remain **two public subsystems** (TTS analog); separate `instanceId` namespaces; optional typed shared registry internally.
- **Updated:** streaming / buffer **open question closed**; open-questions list now states only **implementation/spec** work remains.
- **Added:** **Pre‑implementation review** — risks and inconsistencies before coding (partials vs slot, getter granularity, dual-stack parity, pipeline vs online, alignment ids, migration cut, file path, `number[]`, docs sync).
- **Updated:** **Native retention** — explicit **TTS analog** (batch sink vs streaming chunks), **STT table** (offline vs streaming partials / optional one final slot), pipeline scope; **non‑negotiable #1** scope note for streaming partials.
- **Updated:** **Offline vs streaming STT** — cross-reference retention + spec ownership for finalized streaming segment APIs.
- **Updated:** pre‑implementation item **1** marked **specified** (pointer to decisions); residual = API/spec detail only.
- **Added:** recorded **Decision** — **Offline STT result materialization**: discrete lazy getters (table); **no** masked / bundle bulk getter; stale `resultId` behavior; streaming finals reuse same getters where applicable.
- **Updated:** **Target directions** result-store bullet aligned with discrete getters; **Pre‑implementation** item **2** marked **specified**; **Offline vs streaming** retention cross-reference updated.
- **Updated:** **Non‑negotiable #1** scope line — pointer to **Decision: Offline STT result materialization**.
- **Updated:** pre‑implementation items **3/5/6/7/9** recorded with chosen directions (core tests now + full suite later, unified buffer-id contract across features, 1.0.0 breaking policy/no shims, file→internal bufferId path, docs scope split between `migration.md` and later `stt-offline.md`).
- **Added:** recorded **Decision** — **Native buffer / pipeline registry**: shared registry, **typed handles**, **Phase 1** offline pipeline, **Phase 2** streaming attachment; public STT still two subsystems.
- **Updated:** pre‑implementation item **4** marked **specified** (pointer to registry decision).
- **Updated:** **Decision: PCM transport** + pre‑implementation item **8** — **STT + TTS** bulk PCM-to-JS via **`Float32Array` / JSI `ArrayBuffer`** (same wave); **`number[]`** rejected for bulk PCM (**TTS** `getTtsSamples` replaced); recognition arrays called out separately.

