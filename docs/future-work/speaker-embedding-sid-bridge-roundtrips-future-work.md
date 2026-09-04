# Speaker embedding / SID: bridge roundtrip bottlenecks (future work)

**Status:** Findings 1–4 **done**. Finding 5 remains open.  
**Scope:** TurboModule / JS orchestration costs on the **speaker-embedding** and **speaker-identification** paths after the shared C++ `SpeakerEmbeddingRunner` / `SpeakerEmbeddingManager` migration.  
**Motivation:** Align SID with the live-overload target architecture already used by STT/TTS (and punctuation / enhancement / separation): **one native start**, per-utterance work stays in-process, no PCM or embedding vectors bouncing through JS.

**Related (today):**

- [speaker-embedding-foundation.md](../internal/speaker-embedding-foundation.md) — shared C++ core, SID vs diarization ownership
- [live-overload.md §11](../internal/live-overload.md#11-speaker-identification-live-overload-native-worker) — SID live native worker (Finding 1 done)
- [speaker-identification-live.md](../speaker-identification-live.md) — public `labelLiveSegments` contract
- [speaker-embedding-sharing-verification.md](../internal/speaker-embedding-sharing-verification.md) — device logcat weight-sharing check
- Audio JSI baseline: [liveaudiobuffer-internal.md](../internal/liveaudiobuffer-internal.md), `src/audiobuffer/jsi.ts`

---

## 0. Verdict (what is / is not the regression)

| Layer | Verdict |
|-------|---------|
| Shared C++ `SpeakerEmbeddingRunner` / `ManagerCore` | **Not** the bottleneck. Diarization already uses the same core **without** JS and is the target pattern. |
| C++ registry weight sharing | **Win** (fewer ONNX loads). Orthogonal to transport cost. |
| TurboModule `number[]` embeddings + JS live drain | **Real** cost — pre-dates the migration in shape; migration replaced only the last inference hop (Kotlin AAR / iOS cxx-API → our JNI/C++). |

**Hop count from JS did not increase.** Marshalling quality (e.g. Android `ArrayList<Float>` boxing) and live orchestration remain the issues to fix.

```text
STT / TTS / Punctuation / Enhancement / Separation / SID live
  JS: attach segmentation → start*OfflineLivePipeline once
  Native worker: read seg_live_* + PCM → infer → write outputs
  ✅ Target architecture
```

---

## 1. Finding — Live SID JS orchestration (HIGH) — **DONE**

**Status:** Implemented. `labelLiveSegments` now starts `startSpeakerIdentificationOfflineLivePipeline`; per-utterance work runs in `SpeakerIdentificationOfflineLivePipelineWorker` (Android Kotlin + iOS ObjC++). See [live-overload.md §11](../internal/live-overload.md#11-speaker-identification-live-overload-native-worker).

### Problem (historical)

`labelLiveSegments` previously polled committed speech spans in JS and, per utterance:

1. `getLiveAudioBufferSamplesSlice` (JSI → JS `Float32Array`)
2. `createOfflineAudioBufferFromSamples` (JSI → temp `off_*`)
3. `computeSpeakerEmbeddingOffline(tempId)` (TurboModule; native **re-reads** all samples)
4. `manager.search(embedding)` (TurboModule; embedding as `number[]`)
5. `appendLiveSegment(...)`

That was a **triple PCM path** plus two embedding-related bridge calls.

### What shipped

1. TurboModule `startSpeakerIdentificationOfflineLivePipeline(instanceId, managerId, audioIn, segmentsOut, { attachedSegmentationEngineId, segmentLiveBufferId, threshold })`
2. Android / iOS `SpeakerIdentificationOfflineLivePipelineWorker` extending `OfflineLivePipelineWorker`
3. In-process: live ring slice → embed → manager search → append with `payload.source: 'sid'`
4. `completed` / `getStatus` via streaming pipeline registry; `onLabeled` via `subscribeLiveSegmentBufferEvents`

---

## 2. Finding — No native extract-by-range (HIGH) — **DONE**

**Status:** Implemented. `computeSpeakerEmbeddingOffline(instanceId, bufferId, startSample?, endSample?)` reads an offline slice natively (`OfflineEntry.readSlice` / `pa_get_offline_samples_slice`). `extractFromOfflineAudio(audio, range?)` no longer stages PCM through JS.

### Problem (historical)

The TS engine previously emulated ranges by **JS staging** on the offline path:

```ts
getOfflineAudioBufferSamplesSlice(...)
createOfflineAudioBufferFromSamples(...)
computeSpeakerEmbeddingOffline(temp.bufferId)
releasePipelineAudioBuffer(temp.bufferId)
```

### What shipped

```ts
computeSpeakerEmbeddingOffline(
  instanceId: string,
  audioBufferId: string,
  startSample?: number | null,
  endSample?: number | null
): Promise<{ embedding: number[] }>
```

Half-open `[start, end)`; both omitted = full buffer; exactly one set = reject; zero-length = empty embedding without ONNX.

---

## 3. Finding — Separate extract + search TurboModule calls (MEDIUM) — **DONE**

**Status:** Implemented. Offline `identify` / `labelOfflineSegments` call `identifySpeakerOffline` (one TurboModule: native slice/full → compute → manager search → `{ name }`). Embeddings no longer round-trip through JS on those paths. Low-level `computeSpeakerEmbeddingOffline` / `speakerEmbeddingManagerSearch` remain for enroll and apps that need raw vectors. Live SID already searches in-process (Finding 1).

### Problem (historical)

Every identify did:

1. Extract → embedding marshalled to JS (`number[]` → `Float32Array`)
2. Search → embedding marshalled back to native (`Float32Array` → `number[]` → JNI/`NSArray`)

Two async bridges, two marshallings, and (on Android) the global JNI lock twice. Diarization never leaves C++ between compute and cluster logic.

### What shipped

```ts
identifySpeakerOffline(
  extractorInstanceId: string,
  managerId: string,
  audioBufferId: string,
  threshold: number,
  startSample?: number | null,
  endSample?: number | null
): Promise<{ name: string }>
```

Empty `name` = no match. Range rules match Finding 2. Combined `verifySpeakerOffline` shipped in Finding 4.

---

## 4. Finding — Embedding transport as `number[]` / boxed floats (MEDIUM) — **DONE**

**Status:** Implemented (path D). Offline `verify` / `verifyOfflineSegments` call `verifySpeakerOffline` (compute + manager verify in one TM → `{ ok }`). Android `nativeComputeEmbedding` returns `jfloatArray` instead of boxed `ArrayList&lt;Float&gt;`. **No** embedding JSI in this finding; enroll and low-level extract still use TurboModule `number[]` (infrequent / app-facing). Optional later: JSI `ArrayBuffer` if apps need faster raw-vector pull.

### Problem (historical)

Return path (Android sketch):

`std::vector<float>` → `ArrayList&lt;Float&gt;` (boxed) → `WritableArray` of doubles → JS `number[]` → TS `Float32Array`

Inbound search/verify reversed a similar chain. Dim is small (~192–512) vs PCM; after Findings 1–3 the remaining product path that still crossed JS was verify.

### What shipped

```ts
verifySpeakerOffline(
  instanceId: string,
  managerId: string,
  audioBufferId: string,
  name: string,
  threshold: number,
  startSample?: number | null,
  endSample?: number | null
): Promise<{ ok: boolean }>
```

Zero-length range → `{ ok: false }` without ONNX. Android compute JNI uses `NewFloatArray` / `SetFloatArrayRegion` (same spirit as diarization).

---

## 5. Finding — Coarse Android JNI mutex (LOW–MEDIUM)

### Problem

`android/.../jni/speaker-embedding/sherpa-onnx-speaker-embedding-jni.cpp` uses a process-wide `g_speaker_embedding_mutex` around extractor/manager operations. The shared Runner already has a **per-extractor** `compute_mutex`. The global lock serializes **all** SID instances and can contend with other JNI entry points that touch the same maps under concurrent SID + diarization / multi-session use.

This is contention risk more than copy cost; listed for completeness after the transport findings.

### Direction

- Narrow the global lock to **registry map** mutate/lookup only.
- Rely on Runner `compute_mutex` (and per-manager locks) for inference.
- Do not hold the global lock across ONNX `Compute` / C-API search.

**Priority:** After or alongside native live / range work if profiling shows lock wait; not the first knob to turn for PCM roundtrips.

---

## 6. Suggested implementation order

| Step | Finding | Effort | Impact | Status |
|------|---------|--------|--------|--------|
| C | §1 native SID live pipeline | Medium–large | Matches STT/TTS target architecture | **Done** |
| A | §2 native extract-by-range | Small | Removes JS PCM staging for offline/range | **Done** |
| B | §3 combined identify (or in-worker search) | Small–medium | Drops embedding roundtrip on identify APIs that still cross JS | **Done** |
| D | §4 combined verify + Android unbox (path D) | Small–medium | Residual verify path + JNI boxing hygiene | **Done** |
| E | §5 JNI lock narrowing | Small | Contention hygiene | Open |

---

## 7. Measurement checklist (before / after)

Instrument with a stable tag (e.g. `[SherpaOnnx:sid-live]` / `[SherpaOnnx:sid-bridge]`) and compare Android logcat first:

| Probe | What to log |
|-------|-------------|
| Live span (native worker) | `startSample`, `endSample`, frame count, compute/search/append |
| Offline range extract | native slice + compute only (no JS staging) |
| Extract/search TM (low-level APIs) | wall ms, dim |

Success criteria for §1 (met): **no** PCM `Float32Array` in JS on the live label hot path; one `startSpeakerIdentificationOfflineLivePipeline` call per session; embedding vectors stay native unless the app calls low-level extract.

Success criteria for §2 (met): ranged `extractFromOfflineAudio` calls `computeSpeakerEmbeddingOffline(..., start, end)` with **no** JSI slice / temp offline buffer.

Success criteria for §3 (met): offline `identify` / `labelOfflineSegments` use `identifySpeakerOffline` only (no compute→JS→search); empty name maps to `null` in SID TS.

Success criteria for §4 path D (met): offline `verify` / `verifyOfflineSegments` use `verifySpeakerOffline` only; Android compute returns `jfloatArray` (no `ArrayList&lt;Float&gt;` boxing). JSI embedding transport remains optional later.

---
## 8. Non-goals

- Reverting the shared C++ Runner/Manager migration
- Changing public `labelLiveSegments` / offline SID API shapes (internal swap only)
- Moving diarization clustering through JS (already correct in-process)
- Host CI linking full sherpa C-API for Runner gtests (optional later; registry-key tests remain)
