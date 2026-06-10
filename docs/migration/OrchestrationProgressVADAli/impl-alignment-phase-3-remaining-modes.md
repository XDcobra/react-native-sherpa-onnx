# Implementation plan — Alignment Phase 3: Remaining modes

**Goal:** Implement **`onProgress`** for all alignment code paths not covered in [Phase 2](./impl-alignment-phase-2-accurate-drivers.md), per [phase-0 contract table](./phase-0-alignment-progress-semantics.md).

**Prerequisites:** Phase 1–2 complete for accurate auto drivers.

---

## 1. Scope matrix

| Mode / path | Source file | Contract (phase-0) | Implementation notes |
| --- | --- | --- | --- |
| **`accurate`** + segmentation `off` / absent / not `auto` | [`alignTextToAudio.ts`](../../../src/alignment/alignTextToAudio.ts) → `SherpaOnnx.alignOfflineTextToAudio` | `totalSegments === 1`, single `currentSegment === 0` | Emit **once** at start of `alignOfflineTextToAudio` (after validation, before native). `currentSegmentDurationMs`: full buffer duration from `getPipelineAudioBufferInfo` if cheap; else `0`. |
| **`proportional`** | same | `totalSegments === 1` | Single emit before native. |
| **`estimated`** | same | `max(1, segmentSampleCounts.length)` **if** chunks drive sequential native work; else `1` | **Spike:** inspect native / bridge for `alignOfflineTextToAudio` estimated path — if **one** native call, use `totalSegments === 1` + single emit only. If native exposes per-chunk callback (unlikely), align indices with `segmentSampleCounts[i]`. Default safe: **single-shot** until spike proves multi-step. |
| **`vad`** | [`alignTextToAudio.ts`](../../../src/alignment/alignTextToAudio.ts) | `totalSegments === 1` if zero speech anchors (no-op success); else TBD / single-shot fallback | **Zero-anchor early return** (`segmentsWritten: 0`): **no** `onProgress` (no work). **Non-zero anchors:** single emit before `alignOfflineTextToAudio` with `totalSegments === 1` **or** if later TBD resolved, use `speechAnchorCount` — requires ADR bump. |
| **`aligned`** (internal native mode for accurate off) | same as accurate non-auto | `totalSegments === 1` | Covered by same branch as accurate non-auto. |

---

## 2. Centralisation vs duplication

**Option A (preferred):** Add a small internal helper in **`alignTextToAudio.ts`**:

```ts
function maybeReportNativeAlignmentStart(
  progress: AlignmentProgressSession,
  options: AlignTextToAudioOptions
): void
```

called once before **`SherpaOnnx.alignOfflineTextToAudio`** for all modes that share that path — **guard** so VAD zero-anchor path never calls it.

**Option B:** Duplicate one-liner at each call site — avoid unless control flow diverges.

---

## 3. `estimated` mode spike (blocking for honest multi-step)

**Tasks:**

1. Trace `SherpaOnnx.alignOfflineTextToAudio` for `mode === 'estimated'` in native / TS bridge.
2. If implementation is **monolithic**: document **`totalSegments === 1`** in phase-0 row (finalize “else **`1`**” column).
3. If implementation loops chunks in JS: instrument loop similarly to Phase 2 with **`totalSegments = segmentSampleCounts.length`**.

Deliverable: short note in phase-0 doc + code match.

---

## 4. Validation & engine

- **`validateAlignTextToAudioOptions`:** unchanged unless new fields.
- **`createAlignment`** wrapper: ensure `alignTextToAudio` passes `options` through to `runAlignTextToAudio` unchanged (already does).

---

## 5. Tests

| Test | Assertion |
| --- | --- |
| Proportional + `onProgress` | Exactly one event, `totalSegments === 1`, `fraction === 0`. |
| Accurate + segmentation off | One event before native (spy on `SherpaOnnx.alignOfflineTextToAudio`). |
| VAD zero anchors | Zero progress calls. |
| VAD ≥1 anchor | One progress call before native (unless multi-step TBD implemented). |
| Estimated | Per spike outcome |

---

## 6. Exit criteria

- [ ] Every **`runAlignTextToAudio`** success path that performs meaningful work documents progress behaviour in phase-0 table (no stray “TBD” for shipped modes except explicitly deferred).
- [ ] Phase-0 [testing matrix](./phase-0-alignment-progress-semantics.md#testing-matrix-minimum) rows satisfied for `totalSegments === 1` modes.
- [ ] No duplicate events on code paths that call both a helper and a driver (regression guard).

---

## 7. Non-goals (Phase 3)

- **`AbortSignal`** + progress terminal semantics (README risk — future phase).
- Changing **`OrchestrationProgress`** interface shape.
