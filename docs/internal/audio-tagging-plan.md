# Audio Tagging — Architecture & Implementation Plan

> **Status:** Phase 2 offline oneshot engine landed — Phase 3 segmentation pending  
> **Audience:** SDK Maintainers  
> **Category:** Speech & Media Features (`ModelCategory.AudioTagging` / `audioTagging`)  
> **Target Branch:** TBD (`feat/add-audio-tagging` or similar)  
> **MVP scope:** **Offline batch first** (oneshot + optional offline segmentation); **live overload** as Phase follow-up (same offline weights + speech/energy windows)  
> **Research date:** 2026-09-10  
> **Naming:** `ModelCategory.AudioTagging = 'audioTagging'`; native detect category `"audiotagging"` (alias `"audio_tagging"`).

---

## 1. Executive Summary & Core Decisions

### 1.1 What is Audio Tagging?

Audio tagging classifies **sound events** in an audio clip (speech, music, dog bark, siren, laughter, …) and returns a **ranked list of event labels with probabilities**. Unlike STT it does **not** produce a transcript; unlike VAD/KWS it does **not** localize events in time (upstream docs: *recognize sound events within an audio clip without its temporal localization*).

Typical use: scene / environment awareness, content moderation hints, “what kind of audio is this?”, wake-adjacent event detection (smoke alarm / baby cry) when wake-word KWS is the wrong tool.

Upstream overview: https://k2-fsa.github.io/sherpa/onnx/audio-tagging/

### 1.2 Offline-only upstream (inverse of KWS)

| Question | Answer |
| --- | --- |
| Offline config in sherpa-onnx? | **Yes.** `AudioTaggingConfig` + `AudioTagging` + `OfflineStream` |
| Online / streaming config? | **No.** There is no `OnlineAudioTagger` / online stream API |
| Mic demos upstream? | **Push-to-talk / accumulate then offline compute** (`sherpa-onnx-microphone-offline-audio-tagging`) — not a continuous online decoder |
| SDK MVP | **Offline first** — same family as SLID/SID/enhancement offline. **Not** real streaming like KWS/VAD |
| Live path | **Live overload** (optional Phase): segment live audio → run offline `compute` per window — same pattern as SLID live |
| Why not KWS as primary template? | KWS is streaming-only with `OnlineStream`. Audio tagging is offline classify → **SLID** is the closer API/orchestration analog |

This is the **inverse** of KWS (streaming-only, no offline engine). Audio tagging is **offline-only upstream**, with optional SDK live overload for mic/file streams.

### 1.3 Models: dedicated `audio-tagging-models` packs

- **Runtime:** Already in our prebuilts (same sherpa-onnx AAR / `SherpaOnnxC.framework`). No new native library release needed only for Audio Tagging.
- **Weights:** Dedicated GitHub release tag [`audio-tagging-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models).
- **Families:**
  - **Zipformer** — `OfflineZipformerAudioTaggingModelConfig` / `model.zipformer.model` (single ONNX + labels CSV)
  - **CED** — `model.ced` path (Conditional Event Detection; tiny/mini/small/base)
- **Labels:** Every pack ships `class_labels_indices.csv` (AudioSet-style index → human-readable name). Required at init (`AudioTaggingConfig.labels`).
- Packs are **not** interchangeable with ASR zipformer / KWS packs.

Verified assets on `audio-tagging-models` (as of research):

| Asset |
| --- |
| `sherpa-onnx-zipformer-audio-tagging-2024-04-09.tar.bz2` |
| `sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2` |
| `sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2` |
| `sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2` |
| `sherpa-onnx-ced-small-audio-tagging-2024-04-19.tar.bz2` |
| `sherpa-onnx-ced-base-audio-tagging-2024-04-19.tar.bz2` |

---

## 2. Upstream Availability & Prebuilt Status

Verified against current SDK prebuilts / `third_party/sherpa-onnx` (2026-09-10):

| Component | Android | iOS |
| --- | --- | --- |
| **Underlying Engine** | Offline `AudioTagging` | Same via C-API |
| **Prebuilt Status** | ✅ `com.k2fsa.sherpa.onnx.AudioTagging*` in `classes.jar`; JNI in `libsherpa-onnx-jni.so` | ✅ `SherpaOnnxCreateAudioTagging` / CreateOfflineStream / Compute / FreeResults in `SherpaOnnxC` |
| **Native API Type** | Kotlin: `AudioTagging` + `OfflineStream` + `AudioTaggingConfig` | C-API: `SherpaOnnxAudioTaggingConfig`, `SherpaOnnxAudioEvent`, … |
| **Stream type** | `OfflineStream` (accept waveform → `compute(stream, topK)`) | Same offline stream lifecycle |
| **Extra native work** | Thin helper (+ optional offlineLive / segmented worker) | Thin ObjC++ bridge (+ same workers) |
| **Need custom ORT / CXX?** | **No** — use prebuilt Kotlin bindings | **No** — use prebuilt C-API |

Kotlin surface (from `third_party/sherpa-onnx/.../kotlin-api/AudioTagging.kt`):

```kotlin
class AudioTagging(assetManager: AssetManager? = null, config: AudioTaggingConfig) {
  fun createStream(): OfflineStream
  fun compute(stream: OfflineStream, topK: Int = -1): Array<AudioEvent>
  fun release()
}

data class AudioEvent(val name: String, val index: Int, val prob: Float)

data class AudioTaggingConfig(
  var model: AudioTaggingModelConfig = AudioTaggingModelConfig(), // zipformer and/or ced
  var labels: String = "",
  var topK: Int = 5,
)
```

C-API (abridged): `SherpaOnnxCreateAudioTagging` → `SherpaOnnxAudioTaggingCreateOfflineStream` → accept waveform → `SherpaOnnxAudioTaggingCompute` → `SherpaOnnxAudioTaggingFreeResults` → destroy stream/tagger.

Upstream Android demo: `third_party/sherpa-onnx/android/SherpaOnnxAudioTagging/` (record → `createStream` → accept → `compute` → show events).

Matrix today (`docs/internal/sdk-feature-support-matrix.md`):

| Feature | sherpa offline | sherpa online | SDK offline | SDK live |
| --- | --- | --- | --- | --- |
| Audio Tagging | Yes (`AudioTaggingConfig`) | No | **No** | **No** |

---

## 3. How Audio Tagging Works (product + runtime)

### 3.1 Inference loop (oneshot)

1. Load pack: ONNX (`zipformer` **xor** `ced`) + `class_labels_indices.csv`.
2. `createStream()` → `OfflineStream`.
3. Feed PCM (any sample rate; upstream resamples as needed) via accept-waveform offline.
4. `compute(stream, topK)` → top-K `AudioEvent`s sorted by probability.
5. Destroy stream (and later tagger on unload).

There is **no** online decode loop, no `isReady`, no mid-stream reset-on-hit (contrast KWS).

### 3.2 Semantics

- **Multi-label style ranking:** top-K events for the whole clip (not mutually exclusive exclusive-argmax only — apps usually treat top-1 as primary and rest as alternatives).
- **No time stamps** on events from the core API (`AudioEvent` = name / index / prob only). Temporal structure must come from **our** segmentation windows if we slice long audio.
- **Labels file** maps model output indices to AudioSet-like names (`Speech`, `Music`, `Dog`, …).

### 3.3 Long audio

Upstream oneshot expects a **clip**. Very long files should use **offline segmentation** (fixed windows / energy / VAD) and tag **per segment**, same as SLID segmented mode — otherwise memory and model context degrade.

---

## 4. Feature Analog Selection (why not KWS)

| Candidate | Fit | Verdict |
| --- | --- | --- |
| **KWS** | Real streaming OnlineStream; hit → LiveText | **Wrong primary template** — no online AT engine |
| **VAD** | Streaming (+ offline process sugar) | Wrong — different product; AT is classify-clip |
| **SLID** | Offline classify → labels/scores; oneshot + segmented + **live overload** | **Primary API/orchestration analog** |
| **SID** | Offline embedding + live overload | Secondary — similar overload, different output |
| **Enhancement / punctuation** | Dedicated release tag + collect/license stream | **Collect/license packaging analog** (with KWS) |

**Rule of thumb for this feature:**

- **API shape / pipeline modes** → copy **SLID** (offline + optional live overload).
- **Collect / licenses / download category** → copy **KWS / enhancement** (dedicated release tag — **not** SLID’s ASR piggyback).
- **Do not** invent a fake “streaming AT” factory that pretends OnlineStream exists.

---

## 5. High-Level Architecture & Layering

```mermaid
flowchart TB
  subgraph TS ["TypeScript SDK Layer (src/audio-tagging/)"]
    CLI["createAudioTagging(options)"]
    API["AudioTaggingEngine"]
    DETECT["detectAudioTaggingModel()"]
  end

  subgraph MODES ["Execution modes"]
    M1["Offline oneshot: OfflineAudioBuffer → result"]
    M2["Offline segmented: OfflineAudio + segmentation → per-span events"]
    M3["Live overload: LiveAudio + LiveText + segmentation"]
  end

  subgraph BUFFERS ["Native Zero-Copy Buffer Ecosystem"]
    OAB["OfflineAudioBuffer"]
    LAB["LiveAudioBuffer"]
    LTB["LiveTextBuffer / OfflineSegmentBuffer"]
  end

  subgraph NATIVE ["Native Bridge & Orchestration"]
    AND["Android: SherpaOnnxAudioTaggingHelper + workers"]
    IOS["iOS: SherpaOnnx+AudioTagging + workers"]
    CPP["C++ detect: sherpa-onnx-model-detect-audio-tagging.cpp"]
  end

  subgraph CORE ["sherpa-onnx Core"]
    AT["AudioTagging + OfflineStream"]
    PACK["zipformer|ced ONNX + class_labels_indices.csv"]
  end

  CLI --> API
  API --> M1 & M2 & M3
  M1 & M2 --> OAB
  M3 --> LAB & LTB
  DETECT --> CPP
  AND & IOS --> AT --> PACK
```

### 5.1 Why live overload (not real streaming)?

There is no online AT model. Continuous mic requires:

1. Speech/energy/`continuous_frames` segmentation (or push-to-talk windows), then
2. Offline `compute` on each committed span.

That is exactly SLID live overload — **not** KWS’s always-on OnlineStream worker.

### 5.2 Pipeline I/O contract (integrable)

| Mode | Input | Output | Notes |
| --- | --- | --- | --- |
| Oneshot offline | `OfflineAudioBuffer` | Structured `AudioTaggingResult` (+ optional commit to text/segment buffer) | Primary MVP |
| Segmented offline | `OfflineAudioBuffer` + `segmentation: { mode: 'auto' }` | Per-segment events; optional `OfflineSegmentBuffer` | Long files |
| Live overload | `LiveAudioBuffer` + `LiveTextBuffer` + mandatory segmentation | Commit primary label (and meta top-K) per span; `StreamingPipelineHandle` | Phase after offline |

**Suggested result type:**

```typescript
interface AudioEvent {
  name: string;
  index: number;
  prob: number;
}

interface AudioTaggingResult {
  events: AudioEvent[]; // top-K, highest prob first
  /** Optional: duration of audio tagged (seconds). */
  audioDuration?: number;
}
```

**Buffer-friendly encoding for chaining:**

- Primary event `name` → LiveText / OfflineText segment `text`.
- Full top-K → `meta.events` (plain JSON snapshot — same Fabric-safe projection lesson as KWS LiveText meta).
- `meta.source = 'audio_tagging'` (or `audio_tagging_live`) for filters.

Apps that only need structured results can ignore buffer commits; pipeline screens that chain “tag → UI / gate STT” use buffers.

---

## 6. Public API Design (`src/audio-tagging/`)

### 6.1 Module structure (proposed)

```
src/audio-tagging/
├── index.ts
├── types.ts
├── createAudioTagging.ts
├── detectAudioTaggingModel.ts
├── customConfig.ts
├── offline.ts              # oneshot + segmented
├── live.ts                 # live overload (Phase)
└── __tests__/
```

Naming proposal:

- Factory: `createAudioTagging` (primary).
- Category: `ModelCategory.AudioTagging = 'audioTagging'` (native detect `"audiotagging"` / alias `"audio_tagging"`).
- Docs: `docs/audio-tagging-offline.md` (+ later `docs/audio-tagging-live.md`).

### 6.2 Engine sketch

```typescript
export interface AudioTaggingEngine {
  readonly instanceId: string;

  /** Oneshot or segmented offline. */
  tag(
    audio: OfflineAudioBufferIdSource,
    options?: {
      topK?: number;
      segmentation?: { mode?: 'off' } | { mode: 'auto'; policy?: SegmentationPolicy };
      onProgress?: …;
      onSegment?: (ev: { segmentIndex: number; result: AudioTaggingResult }) => void;
      targetSegmentBuffer?: OfflineSegmentBufferIdSource;
    }
  ): Promise<AudioTaggingResult | AudioTaggingSegmentedResult>;

  /**
   * Live overload — Phase follow-up.
   * Same offline weights; mandatory segmentation over live audio.
   */
  tag(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: {
      topK?: number;
      segmentation: { mode: 'auto'; policy?: SegmentationPolicy };
      onEvent?: (ev: AudioTaggingResult & { segmentIndex: number }) => void;
    }
  ): Promise<StreamingPipelineHandle>;

  destroy(): Promise<void>;
}
```

Init: `initMode: 'auto' | 'custom'` (folder detect vs explicit `model` + `labels` FileSources) — mirror VAD/KWS custom-init pattern.

Tuning: `topK` (config default + per-call override), `numThreads`, `provider`, `debug`, `quantization`.

### 6.3 What apps should **not** need

- Manual OfflineStream accept/compute loops in JS.
- Raw ORT session wiring (prebuilts already expose AT).
- A fake `createStreamingAudioTagging` that implies an online model exists.

---

## 7. Model Detection, Collect & Licenses

### 7.1 Detector (`sherpa-onnx-model-detect-audio-tagging.cpp`)

- New category in unified detect.
- Require: exactly one of zipformer ONNX **or** CED ONNX + `class_labels_indices.csv` (or `labels` filename variants if packs differ — verify during collect).
- `modelType`: `'zipformer' | 'ced'` (concrete); `'auto'` for folder scan.
- `isStreaming = false` always.
- Fail closed on ASR/KWS packs that lack labels CSV / AT layout.

Custom path keys (validate):

| `modelType` | Required keys |
| --- | --- |
| `zipformer` | `model`, `labels` |
| `ced` | `model` (ced onnx), `labels` |

### 7.2 Collect / licenses — **dedicated stream (not SLID piggyback)**

Same rationale as KWS vs SLID:

| | SLID | Audio Tagging |
| --- | --- | --- |
| Dedicated GitHub release? | No (Whisper in `asr-models`) | **Yes:** [`audio-tagging-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models) |
| Collect stream today | Reuse `asr` | **Missing** |
| License CSV today | Reuse ASR CSV | **Need new** `audio-tagging-models-license-status.csv` |

Concrete Phase 1 collect work (mirror KWS / enhancement):

1. Add `scripts/ci/sherpa_audio_tagging_model_release_streams.json`:
   - `release_tag`: `audio-tagging-models`
   - `tree_cache_dir`: `tree-cache/audio-tagging-models`
   - `structure_file`: `test/fixtures/audio-tagging-models-structure.txt`
   - `expected_csv`: `test/fixtures/audio-tagging-models-expected.csv`
   - `license_csv`: `android/src/main/assets/model_licenses/audio-tagging-models-license-status.csv`
2. Register stream in `scripts/ci/sherpa_model_collect_manifest.json` + `collect-model-structures.yml`.
3. Run collect → fixtures + tree-cache + license CSV.
4. Mirror license CSV to `ios/Resources/model_licenses/`.
5. Wire `src/licenses.ts` / download `paths.ts` (`ModelCategory.AudioTagging` → tag `audio-tagging-models`).
6. Example `model-download-config.json` + `recommendedModels` entries (start with **ced-mini** or **zipformer-small** for size).

Do **not** piggyback ASR licenses — these tarballs never appear in `asr-models-license-status.csv`.

### 7.3 Quantization

- Packs commonly ship `model.int8.onnx` (and sometimes fp32 `model.onnx`).
- Universal `quantization` preference string applies during detect.

---

## 8. Native Implementation Details

### 8.1 Android

- Helper: `SherpaOnnxAudioTaggingHelper.kt` wrapping `com.k2fsa.sherpa.onnx.AudioTagging`.
  - Init from detected/custom paths; instance map; `unload` joins any workers.
- Offline path: read `OfflineAudioBuffer` PCM → `createStream` → accept → `compute` → map `AudioEvent[]`.
- Segmented / live: reuse **offlineLive / SLID-style** workers (per-span compute), **not** `KwsStreamingPipelineWorker` OnlineStream loop.
- Bridge: `initializeAudioTagging` / `unloadAudioTagging` / `tagAudioOffline` / (later) `startAudioTaggingLivePipeline`.

### 8.2 iOS

- Bridge category + thin C-API wrapper around `SherpaOnnxCreateAudioTagging` / Compute / FreeResults.
- Same buffer I/O contracts as Android.

### 8.3 Lifecycle / Fabric notes

- Snapshot event arrays to plain JSON before emitting to JS (avoid retaining native HybridData — lesson from KWS LiveText meta).
- Always await worker stop before `release()` (pipeline join lesson).

---

## 9. Phased Delivery Plan

| Phase | Tasks | Deliverables |
| --- | --- | --- |
| **Phase 1: Foundation, Detect, Collect & Licenses** | • `ModelCategory.AudioTagging`<br>• C++ detect/validate (+ JNI/ObjC)<br>• TS `detectAudioTaggingModel`<br>• Collect stream for `audio-tagging-models`<br>• License CSV Android + iOS + `getModelLicenses()`<br>• Update support matrix: AT = offline yes / online no / SDK offline planned / live overload planned | ✅ Detection fixtures + license status for all release assets |
| **Phase 2: Native engine + offline oneshot** | • Android helper + iOS C-API bridge<br>• TS `createAudioTagging` + `tag(offline)` oneshot<br>• `initMode: 'auto' \| 'custom'`<br>• Jest + Android smoke | ✅ Engine lifecycle + oneshot result |
| **Phase 3: Offline segmentation** | • `segmentation: { mode: 'auto' }` per-span tag<br>• Optional target `OfflineSegmentBuffer`<br>• Progress / onSegment callbacks | Long-file safe offline API |
| **Phase 4: Docs + download catalog** | • `docs/audio-tagging-offline.md`<br>• README checklist + models `<details>`<br>• Download manager category wiring | App-facing docs at SLID/enhancement quality |
| **Phase 5: Showcase** | • Example screen (Home): pack init, file tag, top-K HUD, optional segmented toggle<br>• Bundled/small recommended pack + test wavs from release `test_wavs/` | Showcase landed |
| **Phase 6 (optional): Live overload** | • `tag(liveAudio, liveText, { segmentation })`<br>• `docs/audio-tagging-live.md`<br>• Mic + file ingest showcase | Matrix row: live overload Yes |

**Non-goals for MVP:**

- Real streaming / online AudioTagging factory.
- Custom ORT session implementation (prebuilts suffice).
- Temporal event localization inside the model (upstream does not provide it).
- Treating AT packs as ASR/KWS.

---

## 10. Feature Parity Snapshot (target after MVP)

| Feature | sherpa offline | sherpa online | SDK offline / batch | SDK live |
| --- | --- | --- | --- | --- |
| KWS | No | Yes | No | **Real streaming** |
| SLID | Yes | No | Yes | Live overload |
| **Audio Tagging** | **Yes** | **No** | **Yes (MVP)** | **Live overload (Phase 6)** |

---

## 11. Key Benefits of This Architecture

1. **Prebuilts already include AudioTagging** — cost is orchestration + detect/collect, not compiling new sherpa features.
2. **Honest matrix row** — offline classify; live only as overload (no fake OnlineStream).
3. **SLID-shaped API** — oneshot / segmented / later live reuse existing buffer + segmentation machinery.
4. **Dedicated collect/license stream** — same hygiene as KWS/enhancement; no ASR piggyback mistake.
5. **Pipeline-integrable** — audio in via Offline/Live buffers; events out as structured results + optional text/segment commits with plain meta.
6. **Clear boundary vs KWS** — wake phrases → KWS; sound-event taxonomy → Audio Tagging.

---

## 12. Open Decisions (resolve in Phase 1)

1. **Enum / path string:** **Resolved** — `ModelCategory.AudioTagging = 'audioTagging'`; native `"audiotagging"` (+ `"audio_tagging"` alias).
2. **MVP live overload:** include in first ship vs Phase 6 after offline showcase (recommendation: **offline + segmented first**, live next).
3. **Default recommended pack for example:** `ced-mini` (size) vs `zipformer-small` (accuracy) — measure on-device after collect.
4. **Segment policy default for AT:** `continuous_frames` vs `speech_energy_silence` / VAD — AT cares about non-speech events (siren, music), so **energy / fixed windows** may beat speech-only VAD for general tagging; speech-gated windows still useful when AT is used as a speech-scene classifier.

---

## 13. References

- Upstream docs: https://k2-fsa.github.io/sherpa/onnx/audio-tagging/
- Pretrained packs: https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models
- Kotlin API: `third_party/sherpa-onnx/sherpa-onnx/kotlin-api/AudioTagging.kt`
- C-API: `third_party/sherpa-onnx/sherpa-onnx/c-api/c-api.h` (`SherpaOnnxCreateAudioTagging`, …)
- Upstream Android demo: `third_party/sherpa-onnx/android/SherpaOnnxAudioTagging/`
- SDK analogs: [language-identification-offline.md](../language-identification-offline.md), [language-identification-live.md](../language-identification-live.md), [keyword-spotting-plan.md](keyword-spotting-plan.md) (collect pattern), [sdk-feature-support-matrix.md](sdk-feature-support-matrix.md)
- JS WASM example (illustrative): https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/audio_tagging.html
