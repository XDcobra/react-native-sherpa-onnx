# Speaker embedding / SID: bridge roundtrip bottlenecks (future work)

**Status:** Findings 1–5, **§6–§8**, and **§10** **done**. Open follow-up: **§9** (diarization native segment write). Optional later: embedding JSI.  
**Scope:** TurboModule / JS orchestration costs on the **speaker-embedding**, **speaker-identification**, and **diarization** paths after the shared C++ `SpeakerEmbeddingRunner` / `SpeakerEmbeddingManager` migration.  
**Motivation:** Align SID (and keep diarization) with the live-overload target architecture already used by STT/TTS (and punctuation / enhancement / separation): **one native start**, per-utterance / batch work stays in-process, no PCM or embedding vectors bouncing through JS on product hot paths.

**Related (today):**

- [speaker-embedding-foundation.md](../internal/speaker-embedding-foundation.md) — shared C++ core, SID vs diarization ownership
- [live-overload.md §11](../internal/live-overload.md#11-speaker-identification-live-overload-native-worker) — SID live native worker (Finding 1 done)
- [speaker-identification-live.md](../speaker-identification-live.md) — public `labelLiveSegments` contract
- [speaker-identification-offline.md](../speaker-identification-offline.md) — offline SID (identify/verify combined TMs)
- [diarization-offline.md](../diarization-offline.md) — offline diarization (shipped; compute→cluster in-process)
- [speaker-embedding-sharing-verification.md](../internal/speaker-embedding-sharing-verification.md) — device logcat weight-sharing check
- Audio JSI baseline: [liveaudiobuffer-internal.md](../internal/liveaudiobuffer-internal.md), `src/audiobuffer/jsi.ts`

---

## 0. Verdict (what is / is not the regression)

| Layer | Verdict |
|-------|---------|
| Shared C++ `SpeakerEmbeddingRunner` / `ManagerCore` | **Not** the bottleneck. Diarization already uses the same core **without** JS between embed and cluster — still the target pattern for compute. |
| C++ registry weight sharing | **Win** (fewer ONNX loads). Orthogonal to transport cost. |
| TurboModule `number[]` embeddings + JS live drain | **Was** the real cost on SID; Findings 1–5 and §8 closed product hot paths. Residuals: low-level extract, diarization post-result JS materialization. |

**Hop count from JS did not increase** at the shared-Runner migration. Findings 1–5 fixed live orchestration, range extract, combined identify/verify, Android embedding unbox, and Android JNI lock narrowing.

```text
STT / TTS / Punctuation / Enhancement / Separation / SID live
  JS: attach segmentation → start*OfflineLivePipeline once
  Native worker: read seg_live_* + PCM → infer → write outputs
  ✅ Target architecture (SID live met)

Diarization offline compute
  JS: buffer ids → diarizeOffline once
  Native: PCM → embed → cluster → timeline
  ✅ Compute path met; segment materialization still JS (Finding 9)
```

### Post–Finding 1–5 audit snapshot

| Path | vs target |
|------|-----------|
| SID live / identify / verify | **Met** (no PCM/embedding through JS) |
| SID enroll | **Met** (`enrollSpeakerOffline` compute+add; mirror from returned flats) |
| Diarization compute→cluster | **Met** (in-process) |
| Diarization result → offline segments | **Gap** — JS live-append materialize loop |
| Android SID JNI lifetime | **Met** (`shared_ptr` + narrow map lock) |
| Diarization JNI lifetime | **Met** (`shared_ptr` + narrow map lock; Finding 6) |
| iOS SID TM mutex | **Met** (`shared_ptr` + narrow map lock; Finding 7) |
| Internal docs / cursor rule | **Met** (Finding 10) |

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

**Status:** Implemented (path D). Offline `verify` / `verifyOfflineSegments` call `verifySpeakerOffline` (compute + manager verify in one TM → `{ ok }`). Android `nativeComputeEmbedding` returns `jfloatArray` instead of boxed `ArrayList&lt;Float&gt;`. **No** embedding JSI in this finding; enroll closed later in Finding 8; low-level extract still uses TurboModule `number[]`. Optional later: JSI `ArrayBuffer` if apps need faster raw-vector pull.

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

## 5. Finding — Coarse Android JNI mutex (LOW–MEDIUM) — **DONE**

**Status:** Implemented. Android `g_speaker_embedding_mutex` is now registry lookup/mutate only. Extractor/manager maps hold `shared_ptr` so unload during compute cannot UAF. Hot paths (`nativeComputeEmbedding`, manager add/remove/search/verify/contains/numSpeakers/allSpeakers) copy the pointer out and run outside the global lock. `SpeakerEmbeddingManagerWrapper` has a per-manager mutex around C-API ops. Runner `compute_mutex` unchanged. iOS TurboModule mutex narrowed in Finding 7.

### Problem (historical)

`android/.../jni/speaker-embedding/sherpa-onnx-speaker-embedding-jni.cpp` used a process-wide `g_speaker_embedding_mutex` around extractor/manager operations, including ONNX compute and C-API search/verify. That serialized **all** SID instances even though Runner already has a per-extractor `compute_mutex`.

### What shipped

- Map lock: init / create / unload / destroy / shutdown only (plus short lookup)
- Inference: Runner `compute_mutex` + ManagerWrapper mutex
- Lifetime: `shared_ptr` maps; re-init replaces the map entry rather than `release()` in place

---

## 6. Finding — Diarization JNI lifetime (raw pointer after unlock) (MEDIUM) — **DONE**

**Status:** Implemented. Android `g_diarization_instances` and iOS `DiarizationBridgeState` hold `shared_ptr<DiarizationWrapper>`. Hot paths (`process` / `diarizeOffline`, `recluster`, `getClusterEmbeddings`, `cancel`) copy via `LookupDiarization` then run outside the map lock. Init replaces the map entry on success; unload cancels + move-out + erase (no in-place `release()`). Matches SID Finding 5.

### Problem (historical)

Diarization already unlocked `g_diarization_mutex` before `processMonoSamples` (good for cancel). The instance was held as a **raw pointer** copied under the lock. Unload / destroy while a process was running could UAF.

### What shipped

- Map type: `unique_ptr` → `shared_ptr`
- `LookupDiarization` on Android JNI + iOS bridge
- Replace-on-init; move-out unload; cancel still reaches in-flight wrapper

**Priority:** Medium (correctness / concurrency hygiene). Prerequisite for Finding 9 — **met**.

---

## 7. Finding — iOS SID TurboModule mutex still coarse (LOW–MEDIUM) — **DONE**

**Status:** Implemented. iOS `g_speaker_embedding_extractors` / `g_speaker_embedding_managers` hold `shared_ptr` wrappers (State shells removed). Hot paths (`computeSpeakerEmbeddingOffline`, `identifySpeakerOffline`, `verifySpeakerOffline`, manager add/remove/search/verify/contains/numSpeakers/allSpeakers) use `LookupExtractor` / `LookupManager` then run outside the map lock. Init/create replace map entries; unload/destroy move-out. SID live worker holds `shared_ptr` extractor + manager (no raw `.get()` pins). Matches Android Finding 5.

### Problem (historical)

iOS `g_speaker_embedding_mutex` (TurboModule path in `SherpaOnnx+SpeakerEmbeddingInference.mm`) spanned compute / identify / verify / manager C-API calls. Live unlocked after pinning but used raw pointers.

### What shipped

- Flattened maps to `shared_ptr` wrappers + Lookup helpers
- Map lock: init / create / unload / destroy / short lookup only
- Live worker strong refs via `shared_ptr`

**Priority:** Low–medium — **met**.

---

## 8. Finding — SID enroll still marshals embeddings through JS (MEDIUM) — **DONE**

**Status:** Implemented. Product `enroll` / `enrollOfflineSegments` call `enrollSpeakerOffline` (batch buffer ids + optional per-item ranges → compute → `manager.add` in one TM). Returns flattened embeddings once for the JS enrollment mirror. Low-level `compute` / `manager.add` unchanged for apps / `importEnrollments`.

### Problem (historical)

`enroll` / `enrollOfflineSegments` did `computeSpeakerEmbeddingOffline` → embedding `number[]` → JS → `speakerEmbeddingManagerAdd`.

### What shipped

- Spec + Android Helper/Module + iOS Inference: `enrollSpeakerOffline`
- Multi-buffer / multi-span same-name enroll is one native add (`count > 1`)
- Unit tests expect combined TM only on enroll paths

**Priority:** Medium — **met**.

---

## 9. Finding — Diarization result materialization still in JS (MEDIUM)

### Problem

`diarizeOffline` returns a timeline `{ start, end, speaker }[]`. JS then materializes into the offline segment buffer via a live-append → finalize → populate loop (`materializeSegmentsIntoOfflineBuffer` in `src/diarization/index.ts`). Compute→cluster never left C++ (correct), but the **result write** is many small TurboModule hops — same class of “orchestration in JS” as pre-Finding-1 SID live, without PCM/embedding cost.

### Direction

Native write into the empty `segmentsOut` offline segment buffer (or one TM that accepts `audioIn` + `segmentsOut` and fills diarization segments with `kind: 'diarization'`), so JS only awaits completion / counts.

Public `diarize(audioIn, segmentsOut)` shape can stay; internal swap only.

**Priority:** Medium. Medium–large effort. After Finding 6 (lifetime) so process + write share safe session ownership.

---

## 10. Finding — Stale foundation / cursor docs vs shipped diarization (LOW) — **DONE**

**Status:** Implemented. Foundation status/phase table, `.cursor/rules/separation-diarization-pre-1.0.mdc`, and SID offline cross-links describe offline diarization as **shipped**. Backlog points at §9 / live diarization / pyannote evaluator — not greenfield native.

### Problem (historical)

Offline diarization was shipped, but some internal docs still read as Phase-2-planned / “native fehlt”:

- [speaker-embedding-foundation.md](../internal/speaker-embedding-foundation.md) header / phase table lagged §8–§10 reality
- `.cursor/rules/separation-diarization-pre-1.0.mdc` implied diarization native was missing
- Related cross-links called diarization planned/stub

### What shipped

- Foundation: Phase 2 offline **Done**; Phase-2 checklist items marked; related links → offline guide
- Cursor rule: Separation **and** Diarization native shipped; detect checklist done
- SID offline docs: diarization available (not “planned”)
- This file: step F / Finding 10 marked done

---

## 11. Suggested implementation order

Findings 1–5, §6–§8, and §10 are **done**. Remaining open follow-up:

| Step | Finding | Effort | Impact | Status | Why this order |
|------|---------|--------|--------|--------|----------------|
| C | §1 native SID live pipeline | Medium–large | Matches STT/TTS target architecture | **Done** | — |
| A | §2 native extract-by-range | Small | Removes JS PCM staging for offline/range | **Done** | — |
| B | §3 combined identify | Small–medium | Drops embedding roundtrip on identify | **Done** | — |
| D | §4 combined verify + Android unbox | Small–medium | Residual verify path + JNI boxing | **Done** | — |
| E | §5 Android JNI lock narrowing | Small | Contention / lifetime hygiene | **Done** | — |
| F | §10 docs sync (foundation + cursor rule) | Small | Stops stale “diarization missing” planning | **Done** | Cheap; clear mental model before more work |
| G | §6 diarization `shared_ptr` lifetime | Small–medium | Unload-during-process safety | **Done** | Same pattern as §5; prerequisite for §9 |
| H | §7 iOS SID TM mutex parity | Small | Contention hygiene parity with Android | **Done** | Independent of enroll / segment write |
| I | §8 combined enroll (no JS embedding add) | Medium | Closes last SID product embedding gap | **Done** | Builds on stable locks (§5/§7) |
| J | §9 diarization native `segmentsOut` write | Medium–large | Drops JS materialize loop | Open | After §6 lifetime |
| K | Optional embedding JSI | Small–medium | Faster raw-vector apps only | Deferred | Only if low-level extract still hot in profiles |

**Recommendation summary:** next **J** (diarization native `segmentsOut` write). Defer embedding JSI unless profiling shows low-level extract as a real cost.

Draft an **explicit implementation plan per open finding** in that order (one finding at a time), same style as Findings 1–5.

---

## 12. Measurement checklist (before / after)

Instrument with a stable tag (e.g. `[SherpaOnnx:sid-live]` / `[SherpaOnnx:sid-bridge]` / `[SherpaOnnx:diarization]`) and compare Android logcat first:

| Probe | What to log |
|-------|-------------|
| Live span (native worker) | `startSample`, `endSample`, frame count, compute/search/append |
| Offline range extract | native slice + compute only (no JS staging) |
| Extract/search TM (low-level APIs) | wall ms, dim |
| Enroll (after §8) | one combined TM; no compute→add embedding bounce |
| Diarize (after §9) | one native fill of `segmentsOut`; no per-segment JS append |

Success criteria for §1 (met): **no** PCM `Float32Array` in JS on the live label hot path; one `startSpeakerIdentificationOfflineLivePipeline` call per session; embedding vectors stay native unless the app calls low-level extract.

Success criteria for §2 (met): ranged `extractFromOfflineAudio` calls `computeSpeakerEmbeddingOffline(..., start, end)` with **no** JSI slice / temp offline buffer.

Success criteria for §3 (met): offline `identify` / `labelOfflineSegments` use `identifySpeakerOffline` only (no compute→JS→search); empty name maps to `null` in SID TS.

Success criteria for §4 path D (met): offline `verify` / `verifyOfflineSegments` use `verifySpeakerOffline` only; Android compute returns `jfloatArray` (no `ArrayList&lt;Float&gt;` boxing).

Success criteria for §5 (met): Android JNI does not hold `g_speaker_embedding_mutex` across ONNX compute or manager C-API ops; maps use `shared_ptr`; ManagerWrapper serializes C-API calls.

Success criteria for §6 (met): diarization process holds a `shared_ptr` session; unload during process does not UAF.

Success criteria for §7 (met): iOS TM compute/identify/verify/manager ops do not hold `g_speaker_embedding_mutex` across ONNX / C-API work.

Success criteria for §8 (met): `enroll` / `enrollOfflineSegments` do not call separate compute + `manager.add` with embedding `number[]` on the product path (mirror policy documented).

Success criteria for §9: `diarize` fills `segmentsOut` natively (no JS per-segment materialize loop).

Success criteria for §10 (met): foundation status + cursor rule describe diarization offline as shipped; backlog points at §9 / live diarization — not greenfield native.

---

## 13. Non-goals

- Reverting the shared C++ Runner/Manager migration
- Changing public `labelLiveSegments` / offline SID / offline diarization API shapes (internal swap only)
- Moving diarization clustering through JS (already correct in-process)
- Host CI linking full sherpa C-API for Runner gtests (optional later; registry-key tests remain)
- True streaming / live diarization (separate track)
- Replacing the JS enrollment mirror without a native export story ([speaker-embedding-manager-upstream-export-import.md](speaker-embedding-manager-upstream-export-import.md))
