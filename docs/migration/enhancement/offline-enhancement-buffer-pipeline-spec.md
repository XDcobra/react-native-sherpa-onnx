# Offline speech enhancement: `OfflineAudioBuffer` pipeline

**Status:** Specification (implementation pending).  
**Scope:** **Offline** batch denoising only (`gtcrn`, `dpdfnet`). **Online / streaming enhancement** uses `initializeOnlineEnhancement` + live-buffer **`enhance`** pipeline only; this document does **not** redefine streaming behaviour beyond noting **iOS parity** when offline registry work touches shared modules.

---

## 1. Relationship to other pipeline features

| Feature | Primary input | Primary output |
| --- | --- | --- |
| **Offline STT** | `OfflineAudioBuffer` | `OfflineTextBuffer` |
| **Offline TTS** | `OfflineTextBuffer` | `OfflineAudioBuffer` |
| **Offline enhancement (target)** | `OfflineAudioBuffer` | `OfflineAudioBuffer` (pre-allocated **empty** buffer, same pattern as TTS `synthesize`) |

Typical composition:

```text
File / mic → OfflineAudioBuffer₁ → [Offline Enhancement] → OfflineAudioBuffer₂ → STT / Alignment / export
```

Enhancement is a **transform**: read mono PCM from the pipeline registry, run `OfflineSpeechDenoiser`, write result into an output offline entry. It must **not** be a parallel I/O API on the public JS surface (no `enhanceFile` / raw `number[]` samples in the **offline** product API once migration is complete).

---

## 2. Current state (as-is)

### 2.1 Public JS (`src/enhancement/`)

- **`createEnhancement(options)`** → **`EnhancementEngine`** with:
  - **`enhanceFile(inputPath, outputPath?)`** — WAV path in; optional WAV path out; returns **`EnhancedAudio`** (`Float32Array` + `sampleRate`) built from native `number[]` (bridge cost).
  - **`enhanceSamples(samples: number[], sampleRate)`** — legacy array input (not `Float32Array`; not buffer id).
  - **`getSampleRate()`**, **`destroy()`**.
- **`detectEnhancementModel(...)`** — unchanged responsibility (folder / asset detection); accepts **`FileSource`** resolved to absolute `modelDir` + optional `assetName`. Returns `isStreaming: false`.

### 2.2 TurboModule (`src/NativeSherpaOnnx.ts`)

- **`enhanceFile(instanceId, inputPath, outputPath?)`**
- **`enhanceSamples(instanceId, samples: number[], sampleRate)`**

No pipeline **`bufferId`** parameters today.

### 2.3 Native

- **Android:** [`SherpaOnnxEnhancementHelper.kt`](../../../android/src/main/java/com/sherpaonnx/SherpaOnnxEnhancementHelper.kt) — `WaveReader.readWave` + `OfflineSpeechDenoiser.run(samples, rate)`; optional `audio.save(outputPath)`.
- **iOS:** [`SherpaOnnx+Enhancement.mm`](../../../ios/SherpaOnnx+Enhancement.mm) / C++ wrapper — file and in-memory paths analogous to Android.

### 2.4 Documentation

- [`docs/enhancement-offline.md`](../../enhancement-offline.md) (and overview [`speech-enhancement.md`](../../speech-enhancement.md)); streaming/live: [`enhancement-streaming.md`](../../enhancement-streaming.md).

---

## 3. Goals

1. **Single mental model (offline)**  
   Input and output are **`OfflineAudioBuffer`** handles (or typed `*IdSource` unions), resolved via **[`PipelineAudioRegistry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt)** (Android) and the matching iOS registry.

2. **Strong typing (TS)**  
   - Offline API accepts **`OfflineAudioBufferIdSource`** for input and for output (empty buffer created with `createEmptyOfflineAudioBuffer(modelSampleRate)` or appropriate rate from `getEnhancementSampleRate()` / `getSampleRate()` after init).  
   - **Reject at type level** passing a **`LiveAudioBufferRef`** where offline-only enhancement is requested (overload set or distinct method name, e.g. `enhanceOffline` vs future `enhanceLive`).

3. **Remove non–enhancement shortcuts from the offline public API**  
   - Remove **`enhanceFile`** and **`enhanceSamples`** from **`EnhancementEngine`** (and matching TurboModule methods) **without** deprecation.  
   - Callers that need files: **`createOfflineAudioBufferFromFile`** → **`enhanceOffline(in, out)`** → **`saveOfflineAudioBufferToWav`** (or read via future slice APIs if exposed).  
   - No `content://` special cases in the **public** enhancement API; if the registry or file helper already normalizes URIs, keep that **inside** buffer creation, not in `enhance*`.

4. **iOS parity**  
   Every Kotlin / JNI / TurboModule / registry change has a matching iOS implementation and the same id + error contract.

5. **Breaking changes are OK**  
   SDK not published; prefer a clean surface over compatibility shims.

---

## 4. Non-goals (this document)

- Redesign of **online** streaming enhancement (chunk API, flush/reset semantics).  
- Changing **detection** result shape beyond what the shared model-detect pipeline already requires.  
- STT / TTS / Alignment behaviour (only composition examples).

---

## 5. Target API (concrete)

### 5.1 TypeScript (`react-native-sherpa-onnx/enhancement`)

```ts
// Illustrative names — final export names may stay `createEnhancement` + method `enhance`.

interface EnhancementEngine {
  readonly instanceId: string;
  /** Read-only input offline buffer; writes denoised PCM into empty `audioOut`. */
  enhance(
    audioIn: OfflineAudioBufferIdSource,
    audioOut: OfflineAudioBufferIdSource
  ): Promise<void>;
  getSampleRate(): Promise<number>;
  destroy(): Promise<void>;
}
```

- **`audioIn`:** populated **`OfflineAudioBuffer`** (file-backed or RAM); must be **mono** at a rate the denoiser accepts (same rules as today; invalid audio → native error).  
- **`audioOut`:** **empty** offline buffer with **`sampleRate`** equal to the denoiser’s configured rate (call **`getSampleRate()`** after `createEnhancement` / init, mirroring TTS).  
- **Return:** `Promise<void>` — inspect result via **`getPipelineAudioBufferInfo(audioOut)`** or save/export helpers; avoids returning huge `number[]` on the bridge.

### 5.2 TurboModule (sketch)

Replace **`enhanceFile`** / **`enhanceSamples`** with one method, e.g.:

```ts
enhanceOfflineAudioBuffers(
  instanceId: string,
  audioInBufferId: string,
  audioOutBufferId: string
): Promise<void>;
```

Native resolves both ids through **`PipelineAudioRegistry`**, validates kinds (`offline`), ensures **`audioOut`** is empty, runs denoiser, writes full offline buffer contents (or uses existing internal “replace offline buffer body” primitive if one exists; otherwise add a small native writer on `OfflineEntry`).

### 5.3 Native Android

- In **`SherpaOnnxEnhancementHelper`** (or a dedicated small class):  
  - `audioIn` → `registry.getOffline(...)` → float samples + sample rate.  
  - `denoiser.run(...)`.  
  - Write result into **`audioOut`** offline entry (same mutex / lifecycle rules as TTS batch write).  
- Remove path-based **`enhanceFile`** and **`enhanceSamples`** from the **TurboModule** surface once JS no longer calls them; internal temp-file helpers may remain **private** for rare native-only tests if needed.

### 5.4 Native iOS

- Mirror §5.3: read pipeline offline PCM, run wrapper, write to output offline buffer id.  
- Remove public ObjC++ selectors that only served file/array bridge for offline enhancement (after JS migration).

---

## 6. Errors (target alignment)

Reuse the same **string code** style as today where possible; extend with buffer-specific codes for parity with STT/TTS:

| Code (sketch) | Meaning |
| --- | --- |
| `ENHANCEMENT_INIT_ERROR` | Model dir invalid / unsupported type / native init failure |
| `ENHANCEMENT_ERROR` | Instance missing / denoise run failed (generic) |
| `ENHANCEMENT_BUFFER_NOT_FOUND` | Unknown or released **audio** buffer id |
| `ENHANCEMENT_BUFFER_KIND_MISMATCH` | Non-offline buffer passed to offline enhance |
| `ENHANCEMENT_BUFFER_EMPTY` | Input offline buffer has no samples |
| `ENHANCEMENT_OUTPUT_NOT_EMPTY` | Output buffer must be empty (same contract as TTS `synthesize`) |

Exact spellings should match constants exported from **`src/enhancement/types.ts`** (new `EnhancementErrorCode` const object) once implemented.

---

## 7. Migration plan (phased)

| Phase | Work |
| --- | --- |
| **P0** | Spec + docs ([`enhancement-offline.md`](../../enhancement-offline.md)); agree on method names (`enhance` vs `enhanceOffline`). |
| **P1** | TurboModule: add **`enhanceOfflineAudioBuffers`**; Android: registry read/write + tests or manual checklist; iOS: same. |
| **P2** | TypeScript: **`EnhancementEngine.enhance(in, out)`**; remove **`enhanceFile`** / **`enhanceSamples`** from types and implementation; update **`NativeSherpaOnnx.ts`**; **codegen**. |
| **P3** | Example app [`EnhancementScreen.tsx`](../../../example/src/screens/enhancement/EnhancementScreen.tsx): buffer-only flow. |
| **P4** | Remove dead JNI / helper code paths only used by old TurboModule methods. |

**Online enhancement:** leave TurboModule and JS **`createStreamingEnhancement`** as-is until a separate streaming spec; no requirement to move streaming to live pipeline buffers in this phase.

---

## 8. Acceptance criteria (draft)

- No public **`enhanceFile`** / **`enhanceSamples`** on **`EnhancementEngine`**.  
- Offline denoise entry uses **only** offline pipeline buffer ids on the wire.  
- **`docs/enhancement-offline.md`**: offline quick start uses **audiobuffer** + **`enhance`**, structure mirrors **`stt-offline.md`** (quick start, data model, API reference, error table, see also).  
- Android and iOS behave identically for success and buffer error codes.

---

## 9. Related documents

- [Speech enhancement — offline](../../enhancement-offline.md) · [overview](../../speech-enhancement.md)
- [Pipeline audio buffers — offline](../../audiobuffer-offline.md) · [overview](../../audiobuffer.md)  
- [STT buffer-only plan](../stt/stt-pipeline-buffer-only-api-plan.md)  
- [Offline alignment pipeline](../alignment/offline-alignment-pipeline-spec.md)
