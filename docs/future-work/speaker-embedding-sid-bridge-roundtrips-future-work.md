# Speaker embedding / SID: bridge roundtrip bottlenecks (future work)

**Status:** Design note — analysis complete; not implemented.  
**Scope:** TurboModule / JS orchestration costs on the **speaker-embedding** and **speaker-identification** paths after the shared C++ `SpeakerEmbeddingRunner` / `SpeakerEmbeddingManager` migration.  
**Motivation:** Align SID with the live-overload target architecture already used by STT/TTS (and punctuation / enhancement / separation): **one native start**, per-utterance work stays in-process, no PCM or embedding vectors bouncing through JS.

**Related (today):**

- [speaker-embedding-foundation.md](../internal/speaker-embedding-foundation.md) — shared C++ core, SID vs diarization ownership
- [live-overload.md §11](../internal/live-overload.md#11-speaker-identification-live-overload-js-orchestration) — SID live is still JS-orchestrated
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
STT / TTS / Punctuation / Enhancement / Separation live
  JS: attach segmentation → start*OfflineLivePipeline once
  Native worker: read seg_live_* + PCM → infer → write outputs
  ✅ Target architecture

SID labelLiveSegments (today)
  JS poll loop: slice PCM → temp offline → extract TM → search TM → append
  ❌ Exception documented in live-overload.md §11
```

---

## 1. Finding — Live SID JS orchestration (HIGH)

### Problem

`labelLiveSegments` (`src/speaker-identification/live.ts`) polls committed speech spans in JS and, per utterance, roughly:

1. `getLiveAudioBufferSamplesSlice` (JSI → JS `Float32Array`)
2. `createOfflineAudioBufferFromSamples` (JSI → temp `off_*`)
3. `computeSpeakerEmbeddingOffline(tempId)` (TurboModule; native **re-reads** all samples)
4. `manager.search(embedding)` (TurboModule; embedding as `number[]`)
5. `appendLiveSegment(...)`

That is a **triple PCM path** for audio that already lived in the live ring, plus two embedding-related bridge calls, plus a ~50 ms poll. Unlike STT/TTS live, there is **no** `startSpeakerIdentificationOfflineLivePipeline`.

### Why it was left this way

Documented in [live-overload.md §11](../internal/live-overload.md#11-speaker-identification-live-overload-js-orchestration): cheap per-utterance math, existing offline staging building blocks, no prior native worker that writes **segment-buffer labels** with cross-subsystem access to `SpeakerEmbeddingManager`.

### Direction

Keep public `labelLiveSegments` + handle shape; swap the body for a native worker (same pattern as STT):

1. TurboModule `startSpeakerIdentificationOfflineLivePipeline(instanceId, managerId?, audioIn, segmentsOut, { attachedSegmentationEngineId, segmentLiveBufferId, threshold })`
2. Android / iOS `SpeakerIdentificationOfflineLivePipelineWorker` extending `OfflineLivePipelineWorker`
3. In-process: live ring slice → `SpeakerEmbeddingRunner::Compute` (ranges) → `SpeakerEmbeddingManager::Search` → `appendLiveSegment` with `payload.source: 'sid'`
4. `completed` / `getStatus` via streaming pipeline registry (drop JS-synthesized handle internals)

**Priority:** Do this **soon** — SID should match the live-overload target architecture; JS orchestration is the dominant cost on the live path.

---

## 2. Finding — No native extract-by-range (HIGH)

### Problem

`SpeakerEmbeddingRunner` already supports `SampleRange` / ranged `Compute`. The TS engine still emulates ranges by **JS staging**:

```ts
// src/speaker-embedding/engine.ts — range path today
getOfflineAudioBufferSamplesSlice(...)
createOfflineAudioBufferFromSamples(...)
computeSpeakerEmbeddingOffline(temp.bufferId)
releasePipelineAudioBuffer(temp.bufferId)
```

Offline `labelOfflineSegments` pays the same tax per span.

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

**Priority:** Smallest high-ROI step if native live worker is not immediate; also unblocks a cleaner offline label path and is a building block for §1.

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

| Step | Finding | Effort | Impact |
|------|---------|--------|--------|
| A | §2 native extract-by-range | Small | Removes JS PCM staging for offline/range + simplifies live interim |
| B | §3 combined identify (or in-worker search) | Small–medium | Drops embedding roundtrip on identify |
| C | §1 native SID live pipeline | Medium–large | Matches STT/TTS target architecture; removes poll + triple PCM |
| D | §4 JSI / unbox embeddings | Small–medium | Residual path for apps that still pull vectors |
| E | §5 JNI lock narrowing | Small | Contention hygiene |

**Product priority stated for this note:** §1 (native live) should be **pulled forward soon** so SID matches the live-overload Zielbild; A/B are useful stepping stones and reduce risk when C lands.

---

## 7. Measurement checklist (before / after)

Instrument with a stable tag (e.g. `[SherpaOnnx:sid-bridge]`) and compare Android logcat first:

| Probe | What to log |
|-------|-------------|
| Live span start/end | `startSample`, `endSample`, frame count |
| Staging | JSI slice ms, createOffline ms, release ms |
| Extract TM | wall ms, sample count into JNI, dim out |
| Search TM | wall ms |
| Native worker (after §1) | span → compute → search → append ms **without** JS staging markers |

Success criteria for §1: **no** PCM `Float32Array` in JS on the live label hot path; one `start*OfflineLivePipeline`-style bridge call per session; embedding vectors never enter JS unless the app explicitly calls low-level extract.

---

## 8. Non-goals

- Reverting the shared C++ Runner/Manager migration
- Changing public `labelLiveSegments` / offline SID API shapes (internal swap only)
- Moving diarization clustering through JS (already correct in-process)
- Host CI linking full sherpa C-API for Runner gtests (optional later; registry-key tests remain)
