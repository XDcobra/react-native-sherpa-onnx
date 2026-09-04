# Speaker embedding / SID: bridge roundtrip bottlenecks (future work)

**Status:** Finding 1 (native SID live) **done**. Findings 2–5 remain open.  
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

## 2. Finding — No native extract-by-range (HIGH)

### Problem

`SpeakerEmbeddingRunner` already supports `SampleRange` / ranged `Compute`. The TS engine still emulates ranges by **JS staging** on the **offline** path (`labelOfflineSegments` / `extractFromOfflineAudio` with range):

```ts
// src/speaker-embedding/engine.ts — range path today
getOfflineAudioBufferSamplesSlice(...)
createOfflineAudioBufferFromSamples(...)
computeSpeakerEmbeddingOffline(temp.bufferId)
releasePipelineAudioBuffer(temp.bufferId)
```

(Live labeling no longer uses this path after Finding 1.)

### Direction

Extend the bridge:

```ts
computeSpeakerEmbeddingOffline(
  instanceId: string,
  audioBufferId: string,
  startSample?: number,
  endSample?: number
): Promise<{ embedding: number[] /* or ArrayBuffer — see §4 */ }>
```

Native side: read `[start, end)` from the offline/live registry (or mmap slice) and call `Runner::Compute` with ranges — **no** PCM through JS.

**Priority:** High for offline label/enroll range paths.

---

## 3. Finding — Separate extract + search TurboModule calls (MEDIUM)

### Problem

Every identify does:

1. Extract → embedding marshalled to JS (`number[]` → `Float32Array`)
2. Search → embedding marshalled back to native (`Float32Array` → `number[]` → JNI/`NSArray`)

Two async bridges, two marshallings, and (on Android) the global JNI lock twice. Diarization never leaves C++ between compute and cluster logic.

### Direction

Combined native identify APIs, e.g.:

```ts
identifySpeakerOffline(
  extractorInstanceId: string,
  managerId: string,
  audioBufferId: string,
  threshold: number,
  startSample?: number,
  endSample?: number
): Promise<{ name: string }>
```

Keep low-level `compute` / `search` for apps that need raw vectors; hot path (SID label) should not require them.

**Priority:** Medium alone; **high** when bundled with §1 or §2 (native worker or range extract can call Manager in-process without a public combined TM if the worker owns both IDs).

---

## 4. Finding — Embedding transport as `number[]` / boxed floats (MEDIUM)

### Problem

Return path (Android sketch):

`std::vector<float>` → `ArrayList<Float>` (boxed) → `WritableArray` of doubles → JS `number[]` → TS `Float32Array`

Inbound search/verify reverses a similar chain. Dim is small (~192–512) vs PCM, but live multiplies extract+search roundtrips. Audio already has JSI `ArrayBuffer` transport; embeddings do not.

### Direction (pick one or combine)

1. **Prefer not crossing JS** for hot paths (§1 / §3) — best fix.
2. If JS must see vectors: return / accept **`ArrayBuffer` / `Float32Array` via JSI** (extend `__SherpaOnnxJSI` or a dedicated embedding transfer id), same spirit as `getOfflineAudioBufferSamplesSlice`.
3. On Android JNI interim: prefer `jfloatArray` (or fill `WritableArray` from `float*` without `ArrayList<Float>` boxing).

Enrollment `manager.add` flatten to `number[]` is **low** priority (infrequent).

**Priority:** Medium; collapses if §1/§3 land first.

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
| A | §2 native extract-by-range | Small | Removes JS PCM staging for offline/range | Open |
| B | §3 combined identify (or in-worker search) | Small–medium | Drops embedding roundtrip on identify APIs that still cross JS | Open |
| D | §4 JSI / unbox embeddings | Small–medium | Residual path for apps that still pull vectors | Open |
| E | §5 JNI lock narrowing | Small | Contention hygiene | Open |

---

## 7. Measurement checklist (before / after)

Instrument with a stable tag (e.g. `[SherpaOnnx:sid-live]` / `[SherpaOnnx:sid-bridge]`) and compare Android logcat first:

| Probe | What to log |
|-------|-------------|
| Live span (native worker) | `startSample`, `endSample`, frame count, compute/search/append |
| Offline range (until §2) | JSI slice ms, createOffline ms, release ms |
| Extract/search TM (low-level APIs) | wall ms, dim |

Success criteria for §1 (met): **no** PCM `Float32Array` in JS on the live label hot path; one `startSpeakerIdentificationOfflineLivePipeline` call per session; embedding vectors stay native unless the app calls low-level extract.

---
## 8. Non-goals

- Reverting the shared C++ Runner/Manager migration
- Changing public `labelLiveSegments` / offline SID API shapes (internal swap only)
- Moving diarization clustering through JS (already correct in-process)
- Host CI linking full sherpa C-API for Runner gtests (optional later; registry-key tests remain)
