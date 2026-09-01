# Speaker embedding foundation — Internal design

> **Status:** Design note — not implemented.
> **Audience:** SDK maintainers.
> **Strategy:** Ship **Speaker Identification (SID)** first on a shared **Extractor + Manager** layer designed so **Speaker Diarization** can reuse the same embedding engine without rework.
> **User request:** [Discussion #113 — Speaker Identification](https://github.com/XDcobra/react-native-sherpa-onnx/discussions/113)

---

## 1. Goal

Implement speaker features in two phases without building the embedding stack twice:

| Phase | Public module | Uses shared layer |
|-------|---------------|-------------------|
| **1** | `speaker-identification/` | Extractor + Manager |
| **2** | `diarization/` (replaces placeholder) | Same Extractor + `OfflineSpeakerDiarization` native |

**Principle:** The embedding extractor knows only **audio → vector**. It does not know enrollment, clustering, or timeline output. The manager is for **named speakers** (SID). Diarization uses **anonymous cluster indices** and must not overload the manager for clustering.

---

## 2. Layering

```mermaid
flowchart TB
  subgraph phase1 ["Phase 1 — public"]
    SID["src/speaker-identification/"]
  end

  subgraph shared ["Shared — internal + thin exports"]
    EXT["SpeakerEmbeddingEngine"]
    MGR["SpeakerEmbeddingManager"]
    BRIDGE["speakerEmbeddingNativeBridge"]
    CACHE["engine cache keyed by model identity"]
  end

  subgraph phase2 ["Phase 2 — public"]
    DIA["src/diarization/"]
    OSD["OfflineSpeakerDiarization native"]
  end

  SID --> EXT
  SID --> MGR
  DIA --> EXT
  DIA --> OSD
  EXT --> BRIDGE
  MGR --> BRIDGE
  EXT --> CACHE
```

### 2.1 `src/speaker-embedding/` (shared foundation)

| Piece | Responsibility | Diarization-ready rule |
|-------|----------------|------------------------|
| **`SpeakerEmbeddingEngine`** | Load model, `dim`, `destroy()`, create compute streams | Single engine instance shareable across SID + diarization init |
| **`EmbeddingComputeStream`** | Feed PCM (buffer slice or samples), `isReady`, `compute()` → `Float32Array` | Same stream API for per-segment diarization slices |
| **`SpeakerEmbeddingManager`** | `add`, `remove`, `search`, `verify`, `contains`, `numSpeakers` | **Not** used for cluster IDs — only named enrollment |
| **`extractFromOfflineAudio(bufferId, start?, end?)`** | Buffer-first input (SDK convention) | Diarization segments map to the same helper |
| **`speakerEmbeddingNativeBridge`** | TurboModule surface; **Android** → Kotlin helpers on `com.k2fsa.sherpa.onnx.*`; **iOS** → Obj-C++ cxx-API wrappers | Diarization reuses the same bridge layer, not a second extractor init |

**Exports:** Keep most of `speaker-embedding` **internal** (`@internal` / deep import). Phase 1 public surface lives under `react-native-sherpa-onnx/speaker-identification`. Optionally export types only from `speaker-embedding` if needed for advanced consumers.

### 2.2 `src/speaker-identification/` (Phase 1 — public)

High-level SID API on top of shared layer:

```typescript
createSpeakerIdentification(options): SpeakerIdentificationEngine

engine.enroll(name, audioBuffers[]): Promise<void>   // average embeddings
engine.identify(audioBuffer, threshold?): Promise<IdentifyResult>
engine.verify(name, audioBuffer, threshold?): Promise<boolean>
engine.removeSpeaker(name): void
engine.listSpeakers(): string[]
engine.destroy(): Promise<void>
```

**Persistence:** Enrollment storage stays **outside** the extractor — either app-owned or a thin SID helper (`exportEnrollments` / `importEnrollments`). Diarization does not need persistence.

**Typical runtime (personal assistant / owner detection):**

```
VAD or speech segment → extractFromOfflineAudio → manager.search(embedding, threshold)
```

Matches the use case described in [Discussion #113](https://github.com/XDcobra/react-native-sherpa-onnx/discussions/113).

### 2.3 `src/diarization/` (Phase 2 — replace placeholder)

Replace `src/diarization/index.ts` (file-path throws) with a real module that:

1. Accepts optional **`embeddingEngine: SpeakerEmbeddingEngine`** (shared) **or** embedding model path (creates/caches engine).
2. Loads **`OfflineSpeakerDiarization`** (segmentation + clustering native).
3. Returns timeline segments: `{ startSec, endSec, speakerIndex }`.

**Do not** store cluster labels in `SpeakerEmbeddingManager`.

Optional Phase 2b helper:

```typescript
labelDiarizationSegments(segments, manager, threshold): LabeledSegment[]
// speakerIndex 0 → "owner", 1 → unknown, etc.
```

---

## 3. Engine sharing

Diarization config in sherpa-onnx references **both** a segmentation model and an **embedding model path**. Avoid loading two extractors for the same weights.

**Preferred pattern:**

```typescript
// Diarization init
createSpeakerDiarization({
  segmentationModelSource,
  embeddingEngine: sharedEngine, // from SID or cache
  clustering: { threshold, numClusters? },
})
```

**Engine cache key:** `{ modelPath, provider, numThreads }` — same pattern as other SDK engines.

---

## 4. Model categories & detect

| Category | Models | Used by |
|----------|--------|---------|
| **`SpeakerEmbedding`** (new) | [speaker-recongition-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) (WeSpeaker, NeMo, 3D-Speaker, …) | SID + diarization embedding leg |
| **`Diarization`** (existing enum) | Bundles with Pyannote segmentation + matching embedding config | Diarization only |

Add `detectSpeakerEmbeddingModel` and download hints analogous to enhancement/separation. Diarization detect validates **segmentation + embedding** layout.

---

## 5. sherpa-onnx: offline vs streaming (upstream reality)

Investigation against `third_party/sherpa-onnx` (vendored tree):

### 5.1 Speaker Identification / Embedding

| Aspect | sherpa-onnx |
|--------|-------------|
| **API class** | `SpeakerEmbeddingExtractor` + `SpeakerEmbeddingManager` |
| **Config type** | `SpeakerEmbeddingExtractorConfig` — single ONNX model path |
| **Separate online/streaming config?** | **No.** No `OnlineSpeakerEmbeddingExtractor` or streaming-model family (unlike ASR `OnlineRecognizer` vs `OfflineRecognizer`). |
| **Stream object** | Uses `OnlineStream` — **naming only**; it is a waveform feed for batch inference, not a streaming speaker model. |
| **Mic / “live” demos** | App loops: capture chunk → `accept_waveform` → `compute` → `manager.search` ([python-api-examples/speaker-identification.py](third_party/sherpa-onnx/python-api-examples/speaker-identification.py)). |

**SDK implication:** Treat SID as **offline embedding inference**. “Live” SID in the RN SDK = **orchestration** (VAD / live buffer segments + repeated extract + search), similar in spirit to live overload on offline engines — **not** a second model class.

### 5.2 Speaker Diarization

| Aspect | sherpa-onnx |
|--------|-------------|
| **API class** | `OfflineSpeakerDiarization` only |
| **Input** | Full utterance `FloatArray` / `process()` / `processWithCallback()` |
| **Config** | Segmentation (Pyannote) + `SpeakerEmbeddingExtractorConfig` + `FastClusteringConfig` |
| **Streaming / online diarization** | **No** upstream API found (`OnlineSpeakerDiarization` does not exist). |

**SDK implication:** Diarization is **offline batch only** in v1. Long files use SDK buffer + optional progress callback (native `processWithCallback`).

### 5.3 Summary table

| Feature | Offline models | Streaming models (ASR-style) | “Live” UX in product |
|---------|----------------|------------------------------|----------------------|
| **Speaker ID** | Yes (embedding ONNX) | **No separate class** | Yes — via VAD/segment loop + extract/search |
| **Speaker Diarization** | Yes (`OfflineSpeakerDiarization`) | **No** | Deferred — full-file offline first; live overload TBD |

---

## 6. Native bridge pattern in react-native-sherpa-onnx

### 6.1 Established SDK convention (follow this)

Speaker features have upstream **Kotlin bindings** (`Speaker.kt`, `OfflineSpeakerDiarization.kt`). That puts them in the same category as STT, TTS, VAD, Enhancement, and Punctuation — **not** Separation.

| Feature | Android inference | Android model detect | iOS inference |
|---------|-------------------|----------------------|---------------|
| STT | `com.k2fsa.sherpa.onnx.OfflineRecognizer` | C++ detect JNI | C++ cxx wrapper |
| Enhancement | `com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser` | C++ detect JNI | C++ cxx wrapper |
| TTS | `com.k2fsa.sherpa.onnx.OfflineTts` | C++ detect JNI | C++ cxx wrapper |
| VAD | `com.k2fsa.sherpa.onnx.Vad` | C++ detect JNI | C API wrapper |
| **Separation** | **C++ C-API wrapper** (no Kotlin class upstream) | C++ detect JNI | C++ C-API wrapper |
| **Speaker ID / Diarization (planned)** | **`SpeakerEmbeddingExtractor` / `OfflineSpeakerDiarization` via Kotlin** | C++ detect JNI | C++ cxx (or C-API) wrapper |

**Rule:** On Android, use the prebuilt sherpa-onnx Kotlin API (`classes.jar` from `extractSherpaOnnxClasses`) for inference. Reserve custom C++ in `android/src/main/cpp/` for **model detect**, audio decode, and features that lack a Kotlin binding (Separation only, today).

Reference helpers to mirror:

- Android: `android/src/main/java/com/sherpaonnx/enhancement/facade/SherpaOnnxEnhancementHelper.kt`
- iOS: `ios/enhancement/sherpa-onnx-enhancement-wrapper.mm`

### 6.2 RN SDK (this repo) — **nothing implemented yet**

| Location | Speaker embedding | Diarization |
|----------|-------------------|-------------|
| `android/.../speaker*/` | **Does not exist** | **Does not exist** |
| `android/src/main/cpp/` (detect only) | **No** detect yet | **No** detect yet |
| `ios/speaker*/` | **Does not exist** | **Does not exist** |
| `android/.../SherpaOnnxModule.kt` | Only TTS `sid` (voice id), unrelated | **No** |
| `src/diarization/index.ts` | — | **Placeholder** (throws) |
| `src/speaker-identification/` | **Does not exist** | — |

### 6.3 sherpa-onnx upstream bindings

| Path | Role in RN SDK |
|------|----------------|
| `third_party/.../kotlin-api/Speaker.kt` | **Android integration** — `SpeakerEmbeddingExtractor`, `SpeakerEmbeddingManager` |
| `third_party/.../kotlin-api/OfflineSpeakerDiarization.kt` | **Android integration** — Phase 2 diarization |
| `third_party/.../kotlin-api/SpeakerEmbeddingExtractorConfig.kt` | Config factory reference (Android + iOS field parity) |
| `third_party/.../jni/speaker-embedding-*.cc` | Already in `libsherpa-onnx-jni.so`; used by Kotlin classes, not duplicated in RN |
| `third_party/.../c-api/c-api.h` | iOS wrapper target; detect helpers may also call C API |
| `third_party/.../cxx-api/` | Preferred iOS inference surface (same as STT/Enhancement) |

Demo apps: `android/SherpaOnnxSpeakerIdentification/`, `android/SherpaOnnxSpeakerDiarization/`.

### 6.4 Planned native layout

**Android (Phase 1 — SID):**

```
android/src/main/java/com/sherpaonnx/speaker/
  facade/SherpaOnnxSpeakerEmbeddingHelper.kt   # com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor/Manager
  core/SpeakerEmbeddingInstances.kt            # instance registry (like EnhancementInstances)
  config/SpeakerEmbeddingInitOptionsParser.kt
android/src/main/cpp/jni/model_detect/speaker/
  sherpa-onnx-model-detect-speaker-embedding.cpp   # detect only
```

**Android (Phase 2 — Diarization):**

```
android/src/main/java/com/sherpaonnx/diarization/
  facade/SherpaOnnxDiarizationHelper.kt        # com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization
```

**iOS (both phases):**

```
ios/speaker/native/sherpa-onnx-speaker-embedding-wrapper.mm   # cxx-API: extractor + manager
ios/diarization/native/sherpa-onnx-diarization-wrapper.mm     # cxx-API: OfflineSpeakerDiarization
ios/model_detect/sherpa-onnx-model-detect-speaker-embedding.mm  # detect
```

No `android/src/main/cpp/speaker-embedding/` inference wrapper — that path is reserved for features **without** a Kotlin binding (Separation pattern).

---

## 7. Implementation phases

### Phase 1 — Foundation + SID

1. **Android:** `SherpaOnnxSpeakerEmbeddingHelper.kt` using `SpeakerEmbeddingExtractor` + `SpeakerEmbeddingManager` from `com.k2fsa.sherpa.onnx` (Enhancement-style).
2. **iOS:** `sherpa-onnx-speaker-embedding-wrapper.mm` on cxx-API (Enhancement-style).
3. **Detect (both platforms):** C++ model detect for speaker embedding weights.
4. TurboModule / codegen methods + `speakerEmbeddingNativeBridge.ts`.
5. `src/speaker-embedding/` — engine, stream, manager, buffer helpers, engine cache.
6. Model detect + `ModelCategory.SpeakerEmbedding` (or reuse naming).
7. `src/speaker-identification/` — public API.
8. Example screen: enroll + identify (file + optional mic via existing live buffer/VAD).
9. Tests: native bridge mocks, enroll/search/verify round-trip.

### Phase 2 — Diarization

1. **Android:** `SherpaOnnxDiarizationHelper.kt` using `OfflineSpeakerDiarization` from `com.k2fsa.sherpa.onnx`.
2. **iOS:** `sherpa-onnx-diarization-wrapper.mm` on cxx-API.
3. Accept shared `SpeakerEmbeddingEngine` in diarization factory (avoid double load of embedding weights).
4. Replace diarization placeholder; buffer-in timeline-out API.
5. Example diarization screen (replace placeholder).
6. Optional: `labelDiarizationSegments` helper.

### Out of scope for initial phases

- True streaming diarization (no upstream API).
- Speaker verification as a separate product surface (subset of `verify()` — can ship with SID).
- Spoken Language Identification (orthogonal feature).

---

## 8. Design rules (checklist)

- [ ] Extractor API is buffer-first (`OfflineAudioBuffer` slices), not file-path-first.
- [ ] Android inference uses `com.k2fsa.sherpa.onnx` Kotlin classes; iOS uses cxx-API wrappers — **not** the Separation-style C-API inference path.
- [ ] C++ under `android/src/main/cpp/` is for detect (and other non-Kotlin features), not duplicate extractor JNI.
- [ ] One TurboModule bridge surface; no duplicate extractor init in diarization init.
- [ ] Manager holds **names**, not diarization cluster indices.
- [ ] Engine cache prevents double load when SID and diarization share weights.
- [ ] Do not extend the old placeholder API (`initializeDiarization` / `diarizeAudio(path)`).
- [ ] Document that SID “live” = segment orchestration, not a streaming model family.

---

## 9. Related documents

- [Discussion #113 — Speaker Identification request](https://github.com/XDcobra/react-native-sherpa-onnx/discussions/113)
- [diarization.md](../diarization.md) — public stub (to replace when Phase 2 ships)
- [sdk-feature-support-matrix.md](./sdk-feature-support-matrix.md) — add rows when implemented
- Upstream: `third_party/sherpa-onnx/sherpa-onnx/kotlin-api/Speaker.kt`, `OfflineSpeakerDiarization.kt`
- Upstream C API: `third_party/sherpa-onnx/sherpa-onnx/c-api/c-api.h` (speaker embedding + offline diarization sections)
