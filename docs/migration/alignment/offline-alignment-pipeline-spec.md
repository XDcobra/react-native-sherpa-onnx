# Offline Alignment Pipeline Spec (`accurate + vad`)

## Scope

This spec defines the finalized offline pipeline behavior for:

- `mode: 'accurate'`
- `segmentation: { source: 'vad', segmentBuffer, minAnchors? }`

It is intentionally offline-first and buffer-first.

## Contract

- Inputs:
  - `textIn`: offline text buffer (`txt_off_*`)
  - `audioIn`: offline audio buffer (`off_*`)
  - `segmentOut`: caller-owned offline segment buffer (`seg_off_*`)
  - `segmentation.segmentBuffer`: offline segment buffer (`seg_off_*`)
- Output:
  - always writes into caller-provided `segmentOut`
  - returns `{ outputSegmentBufferId, segmentsWritten }`
  - may include advisory fields on zero-write threshold exits:
    - `warningCode`
    - `vadAnchorCount`
    - `minAnchorsApplied`

## Runtime Behavior

1. Read `speech` anchors from `segmentation.segmentBuffer`.
2. Apply `minAnchors` threshold:
   - default: `2`
   - valid range: integer `1..10`
3. If `vadAnchorCount < minAnchors`:
   - success path, zero writes (`segmentsWritten = 0`)
   - warning code:
     - `ALIGNMENT_EMPTY_VAD_ANCHORS` when `vadAnchorCount = 0`
     - `ALIGNMENT_BELOW_MIN_VAD_ANCHORS` when `0 < vadAnchorCount < minAnchors`
4. If `vadAnchorCount >= minAnchors`:
   - partition text with `vadMonotonicWeightDP`
   - run constrained accurate alignment sequentially per mapped anchor
   - write canonical `alignment` segments (`timingMode: "accurate"`)

## Diagnostics

For constrained accurate writes, diagnostics are stored in `payload.tokenMetadata`:

- `constraintSource: "vad"`
- `constraintMode: "hard"`
- `mappingStrategy: "vadMonotonicWeightDP"`
- `textUnitCount`
- `vadAnchorCount`
- `mappedUnitCount`
- `unmappedVadAnchorCount`
- `minAnchorsApplied`
- optional `warningCode` (when applicable)

## Errors

- `ALIGNMENT_CONSTRAINED_ACCURATE_ERROR`:
  - failures inside a valid constrained run (e.g. partition/chunk accurate call failure)
- keep existing `SEGMENT_*` and argument/kind/state validation codes
- keep `ALIGNMENT_ERROR` as generic fallback outside constrained-accurate-specific failures

## Non-goals

- fake streaming / chunked ingest orchestration
- non-VAD segmentation sources
- legacy subtitle result-object APIs
