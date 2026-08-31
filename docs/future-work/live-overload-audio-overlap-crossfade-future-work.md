# Live overload (audio): overlap + crossfade at segment boundaries (future work)

**Status:** Design note — not implemented.  
**Scope:** Live overload workers that run **offline audio→audio** engines on **committed speech segments** (`continuous_frames` checkpoints): **source separation** (Spleeter, UVR) and **enhancement** (offline denoiser live overload).  
**Motivation:** Audible clicks/pops at segment boundaries whose cadence tracks `checkpointIntervalMs` (e.g. every 500 ms vs every 5 s) — observed on multiple model families, not model-specific bugs.

**Related (today):**

- [separation-offline.md](../separation-offline.md) — live overload warning on boundary artifacts  
- [offlineOrchestrator.ts](../../src/pipeline/offlineOrchestrator.ts) — offline `overlapSamples` append path  
- [SeparationOfflineLivePipelineWorker.kt](../../android/src/main/java/com/sherpaonnx/separation/pipeline/SeparationOfflineLivePipelineWorker.kt) — naive stem append  
- [sub-06-enhancement-live-overload.md](../migration/liveOverload/sub-06-enhancement-live-overload.md) — OQ-6.2 (deferred overlap option)

---

## 1. Problem statement

Live overload drives an **offline** separator/enhancer on a **live** input buffer. Segmentation with `continuous_frames` commits fixed-duration speech segments (`policy_checkpoint`). Each committed segment triggers:

1. Slice PCM from the live input (`startSample` … `endSample`)  
2. One full offline inference pass (no cross-chunk state)  
3. Append output samples to live stem/output buffers **back-to-back**

When `checkpointIntervalMs` is 500, listeners often hear a **loud click or tonal burst roughly every 500 ms**; at 5000 ms, the same artifact appears roughly every 5 s. The timing tracks the checkpoint interval, not model branding (reproduced on Spleeter and UVR).

This is **expected** given the current architecture (documented in [separation-offline.md](../separation-offline.md)), but it is ** worse on the live path** than necessary because live workers do not apply any boundary stitching that offline orchestration partially addresses.

---

## 2. Root cause (architecture, not weights)

| Factor | Effect |
|--------|--------|
| Offline STFT/chunk models | Each chunk is processed as an isolated utterance; phase/gain at chunk edges differs from interior. |
| No inter-chunk state | `SeparationOfflineLivePipelineWorker` / `EnhancementOfflineLivePipelineWorker` reset the native engine context per segment. |
| Naive concatenation | `tryAppendSamples(...)` appends stem/output PCM with **zero overlap** and **zero crossfade**. |
| `continuous_frames` | Hard time cuts — not silence-aware — so boundaries often fall mid-waveform. |

**Not the primary explanation:** a defect in Spleeter vs UVR weights. Both share the same live pipeline glue.

---

## 3. What offline orchestration does today

Offline segmented separation (`runOfflineSeparationPipeline` → `runOfflineAudioMultiOutputPipeline`) accepts `overlapSamples?: number` on `SeparateOptions`.

Current behaviour in `appendAudioSegmentOutputToAccumulator`:

- For segment index `> 0`, if `overlapSamples > 0`, **trim** the first `overlapSamples` samples from the segment output before appending to the accumulator.  
- There is **no input-side overlap extension** for audio segments in the orchestrator loop today (unlike text, which rewinds `overlapChars` on the input slice).  
- There is **no crossfade** — the migration spec mentions “overlap/crossfade”, but the shipped audio path is **trim-only**.

So offline overlap is a **partial** mitigation hook; live overload has **none**.

---

## 4. Proposed direction

Add **overlap + crossfade** (or overlap-add) when appending live overload **audio outputs** after each committed segment.

### 4.1 Processing model (per segment index `i`)

Assume overlap length `O` samples (derived from options or policy — see §5).

**Segment `i === 0`**

- Input slice: `[start, end)` as today.  
- Append full output to live buffer(s).

**Segment `i > 0`**

1. **Input overlap:** extend slice start backward by `O` samples (clamp at 0):  
   `sliceStart = max(segment.startSample - O, 0)`  
   Run offline inference on `[sliceStart, end)` (longer context for the model).  
2. **Output overlap region:** the first `O'` samples of the new output correspond to the overlap window (`O' ≈ O`, or model output length mapping if lengths differ — must be validated per feature).  
3. **Crossfade append:** instead of blind `tryAppendSamples(fullOutput)`, blend the overlap region with the **tail already written** to each output live buffer:  
   - `fadeOut`: tail `O'` samples in accumulator (weight 1 → 0)  
   - `fadeIn`: head `O'` samples of new chunk (weight 0 → 1)  
   - Append only the **non-overlapped** tail of the new chunk (`output[O'..]`).

Linear fade is acceptable for v1; raised-cosine (Hann) is a low-cost v2 improvement.

### 4.2 Where to implement

| Layer | Recommendation |
|-------|----------------|
| **Shared native helper** | Prefer one Kotlin/Swift helper used by `SeparationOfflineLivePipelineWorker` and `EnhancementOfflineLivePipelineWorker` (both audio→audio, same append shape). |
| **Not in JS** | Boundary stitching must run where PCM is appended; avoid shipping overlap windows across the bridge. |
| **Optional TS surface** | See §5 — may stay feature-local or move to shared live-pipeline options. |

STT/TTS/punctuation live overload are **out of scope** (text domain; different discontinuity semantics).

---

## 5. API / configuration (revisit OQ-6.2)

[sub-06-enhancement-live-overload.md](../migration/liveOverload/sub-06-enhancement-live-overload.md) **OQ-6.2** deferred a top-level `overlapSamples` on live overload (“policy-driven only”). Boundary clicks on separation motivate revisiting that decision.

**Options (pick one in implementation PR):**

| Option | Pros | Cons |
|--------|------|------|
| **A. Feature option** `overlapSamples` on `SeparationLivePipelineOptions` / enhancement live options | Matches offline `SeparateOptions`; explicit tuning | Two knobs with `checkpointIntervalMs` |
| **B. Policy field** e.g. `continuous_frames.overlapMs` / `overlapSamples` | Keeps live overload option shape minimal | Couples stitching to segmentation policy |
| **C. Sensible default, no public knob (v1)** | Fast to ship; e.g. `O = min(2048, checkpointSamples/4)` | Harder for apps to tune |

**Recommendation:** **A + documented default** (mirror offline separation), with **0 = today’s behaviour** (opt-in stitching). Document interaction:

- Larger `checkpointIntervalMs` → fewer boundaries, but each boundary may carry more energy if unstitched.  
- `overlapSamples` should be **≤ half of checkpoint samples** to avoid processing mostly duplicate context.  
- At 44.1 kHz, starting point for experiments: `O ≈ 2048–4096` (~46–93 ms), tune by ear.

---

## 6. Implementation checklist

- [ ] Shared helper: `appendLiveAudioWithCrossfade(output, liveEntry, overlapSamples, segmentIndex)` (+ iOS parity).  
- [ ] Input slice extension in workers when `overlapSamples > 0 && segmentIndex > 0`.  
- [ ] Handle output length ≠ input length (if native separation ever returns different counts — assert or map in wrapper).  
- [ ] Wire **separation** live overload first (user-visible Spleeter/UVR case).  
- [ ] Wire **enhancement** live overload (same helper).  
- [ ] Unit/integration tests: synthetic sine/discontinuity — measure max delta at boundary with/without crossfade.  
- [ ] Example app note in Separation live overload UI (overlap optional field).  
- [ ] Update [separation-offline.md](../separation-offline.md) — link here; clarify that overlap reduces but does not eliminate chunking artifacts vs true streaming models.

---

## 7. Non-goals

- **True online separation/enhancement models** — out of scope; overlap stitching does not replace streaming weights.  
- **Changing `continuous_frames` checkpoint semantics** — still time-based cuts; overlap only affects how outputs are glued.  
- **Offline orchestrator crossfade in the same PR** — can reuse the same helper later for parity (offline trim-only → full crossfade).  
- **Automatic `checkpointIntervalMs` tuning** — remains app/SDK policy; not inferred from overlap.

---

## 8. Validation plan

1. **Repro baseline:** Live overload separation, `checkpointIntervalMs: 500`, `overlapSamples: 0` → periodic clicks at ~500 ms.  
2. **With overlap:** same checkpoint, `overlapSamples: 2048` (or default) → same cadence boundaries **inaudible or strongly reduced** on steady-state material.  
3. **Control:** Offline batch on full file (`segmentation.mode: 'off'`) → clean reference.  
4. **Regression:** Segment count / total output duration unchanged (overlap append must preserve timeline length, not shorten or duplicate wall-clock output).  
5. **Models:** At least one Spleeter + one UVR fixture (confirms model-agnostic glue fix).

---

## 9. Open questions

1. Should crossfade weights be **linear** or **Hann** by default?  
2. If native output length differs from input chunk length (padding inside sherpa-onnx), how is `O'` mapped?  
3. Should overlap apply on the **finalize** segment only at the leading edge (never trailing)?  
4. Revisit **OQ-6.2** formally: accept top-level `overlapSamples` on all audio live-overload options vs policy-only field.  
5. Optional future: **input overlap without crossfade** (offline-style trim-only) as a compatibility mode — likely insufficient alone for separation clicks.

---

## 10. Related documents

- [streaming-pipelines-overview.md](../streaming-pipelines-overview.md) — live pipeline handle lifecycle  
- [offline-stt-live-pipeline-mandatory-segmentation.md](../migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md) — live overload matrix (separation row)  
- [sub-04-transfer-offline-orchestration.md](../migration/segmentationEngine/sub-04-transfer-offline-orchestration.md) — orchestrator overlap/crossfade intent  
- [segmentation-engine.md](../segmentation-engine.md) — `continuous_frames` / `checkpointIntervalMs`
