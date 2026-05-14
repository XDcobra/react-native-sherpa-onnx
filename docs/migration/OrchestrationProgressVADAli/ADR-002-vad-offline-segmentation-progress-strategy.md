# ADR-002: VAD offline segmentation + progress strategy

| Field | Value |
| --- | --- |
| Status | **Accepted (Phase 0 design lock)** |
| Date | 2026-05-14 |
| Context | Public SDK (pre-release); keep legacy VAD offline behavior unless segmentation is explicitly enabled. |

## Context

Current VAD offline behavior (`createStreamingVAD().process` with `off_*` input) executes one native `runVadOffline(...)` pass over the full buffer.

Gaps versus orchestration consistency goals:

- No `segmentation` control on offline VAD options.
- No `onProgress` payload aligned with `OrchestrationProgress`.
- No explicit cancellation contract for segmented offline loops.

See migration overview in [README.md](./README.md) section 3 and implementation plan [impl-vad-offline-phase-0-api-design.md](./impl-vad-offline-phase-0-api-design.md).

## Decision

### 1) Public API contract (locked)

`VADOfflineRunOptions` is extended with:

- `segmentation?: { mode?: 'off' | 'auto'; policy?: SegmentationPolicy }`
- `onProgress?: (progress: OrchestrationProgress) => void`
- `abortSignal?: AbortSignal`

Canonical payload type is `OrchestrationProgress` from `src/pipeline/offlineOrchestrator.ts`.

### 2) Segmentation mode policy (locked)

- `segmentation` omitted => treat as `mode: 'off'`.
- `mode: 'off'` => preserve legacy single native `runVadOffline(...)` pass.
- `mode: 'auto'` => segmented offline path (Phase 1+).
- `mode: 'manual'` is not supported for VAD offline v1.

### 3) Output buffer compatibility (locked)

`VADOfflineProcessInput.segmentOut` stays compatible with both:

- `seg_off_*` (offline segment buffer)
- `seg_live_*` (live segment buffer)

No narrowing in Phase 0.

### 4) Native contract decision: slice vs. temp buffer (locked)

V1 uses **TS-managed temp buffer slicing** (no immediate native bridge signature change):

1. Build speech segments with segmentation engine (`segmentOfflineBuffer` + `getSegments`, domain `speech`).
2. For each segment, materialize temp offline audio slice in JS/TS and call existing native `runVadOffline(...)`.
3. Rebase produced segment sample offsets by the segment start offset.
4. Merge rebased segments in order:
   - direct append path for `seg_live_*` target,
   - staged conversion for `seg_off_*` target using existing segment-buffer bridge operations.

This avoids adding a new `runVadOffline` range API in Phase 1.

### 5) Progress semantics (locked)

For segmented mode (`mode !== 'off'`) in Phase 2:

- Fire `onProgress` **before** each per-segment native VAD call.
- `totalSegments` is known before first call.
- Formula: `fraction = totalSegments > 0 ? currentSegment / totalSegments : 1`.

For `mode: 'off'`:

- No `onProgress` emission in v1 (parity with single-pass STT behavior).

### 6) Cancellation semantics (locked)

`abortSignal` is part of the public offline options in Phase 0. Runtime checks and termination semantics are implemented with segmented execution (Phase 1/2), not in single-pass mode.

## Consequences

### Positive

- API is locked early without changing legacy default behavior.
- Segmented rollout is controlled behind explicit `segmentation.mode`.
- Future progress contract aligns with existing offline orchestrator semantics.

### Trade-offs

- Temp-buffer orchestration introduces extra JS/native calls versus one monolithic pass.

## Phase-1 implementation status

Phase 1 is implemented with the following behavior (still without `onProgress` emission):

- `segmentation.mode === 'auto'` runs segmentation (`segmentOfflineBuffer` + `getSegments`) and executes `runVadOffline` per speech slice.
- Per-slice summaries are aggregated by field-wise sum (`chunksProcessed`, `unitsRead`, `unitsWritten`, `segmentCount`, `speechDurationMs`).
- Per-slice segment offsets are rebased to original audio sample coordinates before merge.
- Merge targets:
   - `seg_live_*`: direct append into caller target.
   - `seg_off_*`: staging live segment buffer + `populateOfflineSegmentBufferIfEmpty(...)` into caller target.
- Empty speech segmentation result (`0` speech slices): deterministic success with zero summary and no native per-slice VAD calls.

## Compatibility and migration

- Existing callers with missing `segmentation` keep current behavior.
- Existing callers with `segmentation.mode: 'off'` keep current behavior.
- New fields are optional and backward compatible.

## Non-goals

- Streaming VAD progress handles (`onSegmentAppended` remains the streaming model).
- Retry/recovery parity with full orchestrator in Phase 0.
- Diarization/separation work.

## References

- [README.md](./README.md)
- [impl-vad-offline-phase-0-api-design.md](./impl-vad-offline-phase-0-api-design.md)
- [impl-vad-offline-phase-1-segment-loop.md](./impl-vad-offline-phase-1-segment-loop.md)
- [impl-vad-offline-phase-2-progress.md](./impl-vad-offline-phase-2-progress.md)
- [../../../src/pipeline/offlineOrchestrator.ts](../../../src/pipeline/offlineOrchestrator.ts)
