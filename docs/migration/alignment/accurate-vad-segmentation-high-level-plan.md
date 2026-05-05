# Alignment `accurate + vad` High-Level Plan (Cold Cut)

> [!WARNING]
> Superseded migration content.
>
> This document is superseded by:
> - `docs/migration/alignment/alignment_migration_overview.md`
> - `docs/migration/alignment/sub-01-public-api-contract.md`
> - `docs/migration/alignment/sub-02-linker-path3-core.md`
> - `docs/migration/alignment/sub-03-accurate-strategy-a-integration.md`
> - `docs/migration/alignment/sub-04-accurate-strategy-b-integration.md`
>
> Keep this file only for historical context where it still contains unique buffer/anchor notes.

## Goal

Implement `mode: 'accurate'` + `segmentation.source: 'vad'` as a first-class, public SDK path in a hard/cold cut manner:

- no backward compatibility layer
- no legacy result-object outputs
- no mode explosion (`accurate+vad` stays an orthogonal composition, not a new mode literal)
- deterministic behavior and error mapping across JS/Android/iOS

Current status in codebase (already verified):

- Type-level preparation exists (`AlignTextToAudioOptionsAccurate` allows `segmentation`).
- JS runtime currently rejects this combination with `ALIGNMENT_ERROR`.
- Android and iOS currently reject this combination with deterministic `ALIGNMENT_ERROR`.

This plan closes that prepared-but-not-implemented gap.

---

## Scope

In scope:

- Enable runtime execution for:
  - `mode: 'accurate'`
  - `segmentation: { source: 'vad'; segmentBuffer: OfflineSegmentBufferIdSource }`
- Keep output contract unchanged:
  - caller-provided `segmentOut` buffer
  - return `{ outputSegmentBufferId, segmentsWritten }`
- Preserve hard-cut architecture:
  - no subtitle result-object return
  - no legacy path reintroduction

Out of scope:

- Any reintroduction of `AlignTextToAudioResult` / `SubtitleTimingItem`
- Generic streaming alignment API
- Non-VAD segmentation sources

---

## Non-negotiable contract rules (to keep)

1. Input buffer kinds:
   - `textIn`: `txt_off_*`
   - `audioIn`: `off_*`
   - `segmentOut`: `seg_off_*`
   - `segmentation.segmentBuffer`: `seg_off_*` only

2. Output ownership:
   - alignment writes only into caller-owned `segmentOut`
   - no internal output buffer auto-create

3. Orthogonal options:
   - `mode` remains timing engine selector
   - `segmentation` remains optional side input

4. Cold cut:
   - remove blockers, do not introduce compatibility toggles
   - no dual behaviors behind hidden flags

---

## Target semantics for `accurate + vad`

Anchor policy for first rollout is fixed:

- **hard anchors only**
- VAD anchors are strict temporal constraints (no cross-anchor spillover in constrained accurate path)
- soft-anchor behavior is explicitly out of scope for this rollout and can be considered in a later follow-up plan

Text partitioning policy for first rollout is fixed:

- reuse existing deterministic `vadMonotonicWeightDP` mapping (same core strategy as standalone `mode: 'vad'`)
- no new partition heuristic is introduced for constrained accurate in this phase
- mismatch handling remains deterministic:
  - `textUnits > vadAnchors`: multiple units may map to one anchor
  - `vadAnchors > textUnits`: extra anchors may remain unmapped and must be reported in diagnostics

Empty-anchor policy for first rollout is fixed:

- `accurate + vad` with zero valid VAD speech anchors is a valid success path
- return `{ outputSegmentBufferId, segmentsWritten: 0 }` (same policy as standalone `mode: 'vad'`)
- no reject on empty anchors; diagnostics should indicate `vadAnchorCount=0` and zero mapped units

Minimum-anchor threshold policy for first rollout is fixed:

- `accurate + vad` introduces `segmentation.minAnchors?: number` (optional)
- default is `2` when omitted
- validation is deterministic:
  - integer only
  - range `1..10`
  - invalid value rejects with existing argument validation code path
- threshold semantics:
  - use only valid `speech` anchors after normalization/filtering
  - if `vadAnchorCount < minAnchors`, return success with zero writes:
    - `{ outputSegmentBufferId, segmentsWritten: 0 }`
    - diagnostics include `vadAnchorCount`, `minAnchorsApplied`, and warning code
  - if `vadAnchorCount >= minAnchors`, run constrained accurate execution normally

Minimum-anchor outcome matrix (canonical):

- `vadAnchorCount = 0` -> success, zero writes, warning (`ALIGNMENT_EMPTY_VAD_ANCHORS`)
- `0 < vadAnchorCount < minAnchors` -> success, zero writes, warning (`ALIGNMENT_BELOW_MIN_VAD_ANCHORS`)
- `vadAnchorCount >= minAnchors` -> constrained accurate execution path

Granularity policy for first rollout is fixed:

- constrained `accurate + vad` initially supports only `sentence | word`
- `character` is rejected in this rollout for deterministic behavior and simpler cross-platform parity
- `character` support can be revisited in a dedicated follow-up once constrained-accurate baseline is stable

Diagnostics schema policy for first rollout is fixed:

- diagnostics are written in `payload.tokenMetadata` (single canonical location)
- mandatory keys (always present on constrained `accurate + vad` writes):
  - `constraintSource: 'vad'`
  - `constraintMode: 'hard'`
  - `mappingStrategy: 'vadMonotonicWeightDP'`
  - `textUnitCount: number`
  - `vadAnchorCount: number`
  - `mappedUnitCount: number`
  - `unmappedVadAnchorCount: number`
  - `minAnchorsApplied: number`
- optional keys (present only when computed/needed):
  - `mappingCost?: number`
  - `mappingConfidence?: number`
  - `warningCode?: string` (e.g. empty-anchor success path)
  - `constraintViolationCount?: number`

Reference JSON shape:

```json
{
  "tokenMetadata": {
    "constraintSource": "vad",
    "constraintMode": "hard",
    "mappingStrategy": "vadMonotonicWeightDP",
    "textUnitCount": 12,
    "vadAnchorCount": 4,
    "mappedUnitCount": 12,
    "unmappedVadAnchorCount": 0,
    "mappingCost": 0.18,
    "mappingConfidence": 0.94,
    "warningCode": "ALIGNMENT_EMPTY_VAD_ANCHORS",
    "constraintViolationCount": 0
  }
}
```

Error code policy for first rollout is fixed:

- introduce one explicit constrained-accurate runtime error code:
  - `ALIGNMENT_CONSTRAINED_ACCURATE_ERROR`
- use this code for execution failures inside valid `accurate + vad` constrained runs
  - examples: constrained CTC execution failure, partition-level constrained alignment failure
- keep existing `SEGMENT_*` and existing alignment validation codes for argument/kind/state validation
  - examples: wrong buffer kind/state/not found/invalid argument
- keep existing `ALIGNMENT_ERROR` as generic fallback outside constrained-accurate-specific runtime failures

Performance policy for first rollout is fixed:

- constrained `accurate + vad` executes **strict sequential per mapped VAD anchor**
- no parallel anchor execution in this phase
- no intra-anchor batching/chunking pipeline in this phase
- no fake-streaming behavior in this phase
- existing offline memory constraints remain applicable (`OFFLINE_OOM` may still occur on large inputs)
- full batched/chunked ("fake streaming") alignment is explicitly deferred to a future feature
- optional runtime warning/diagnostic thresholds (anchor count / input duration) are allowed, but must not change execution semantics

High-level execution model:

1. Read VAD anchors from `segmentation.segmentBuffer` (`speech` segments only).
2. Use anchors as hard temporal partitions.
3. Run accurate alignment (CTC) per partition (or equivalent constrained accurate pass).
4. Produce canonical `alignment` segments in `segmentOut` with `timingMode: 'accurate'`.
5. Include diagnostics that indicate VAD-constrained accurate path was used.

Important: this should remain "accurate first, VAD constrained", not "vad mode with accurate label".

---

## Implementation phases

### Phase 1: Lock behavior spec and invariants

Files:

- `docs/alignment.md`
- this document

Tasks:

- Define exact runtime behavior for:
  - anchor usage strategy
  - text unit splitting and assignment into anchors
  - empty/mismatch handling
  - diagnostics payload keys
- Freeze error-code matrix for invalid combinations and runtime failures.

Acceptance:

- No ambiguous runtime behavior left.
- All branch outcomes mapped to stable codes/messages.

---

### Phase 2: JS facade unblocking and strict validation

Files:

- `src/alignment/alignTextToAudio.ts`
- `src/alignment/types.ts` (if minor refinements needed)

Tasks:

- Remove current JS hard-reject for `accurate + vad`.
- Enforce strict requirements for this combo:
  - `modelPath` (`FileSource`) required
  - `segmentation.source === 'vad'` required
  - segmentation buffer id must resolve as offline segment buffer
- Build native options for constrained accurate run (e.g. segmentation identifiers / strategy flags).
- Keep `mode: 'vad'` behavior unchanged.

Acceptance:

- JS no longer rejects valid `accurate + vad`.
- JS rejects invalid `accurate + vad` deterministically before native call.

---

### Phase 3: Native contract extension (TurboModule payload)

Files:

- `src/NativeSherpaOnnx.ts`
- Android bridge/module pass-through
- iOS bridge signature/options parse

Tasks:

- Confirm and finalize options fields required for native constrained accurate run.
- Keep method shape stable (`alignOfflineTextToAudio(...)`), extend `options` contract only.
- Ensure Android/iOS parse the same option keys and semantics.

Acceptance:

- Single cross-platform contract; no platform-specific option naming drift.

---

### Phase 4: Android runtime implementation

Files:

- `android/src/main/java/com/sherpaonnx/alignment/facade/SherpaOnnxAlignmentHelper.kt`
- `android/src/main/java/com/sherpaonnx/alignment/core/AlignmentOptionParsers.kt`
- optional helper/core files under `alignment/core`

Tasks:

- Replace current `accurate + vad` rejection with execution path:
  - read/validate anchors from segmentation buffer
  - apply constrained accurate alignment strategy
  - write canonical `alignment` records to `segmentOut`
- Add deterministic diagnostics metadata for constrained path.
- Keep existing `accurate` (without segmentation) path behavior unchanged.

Acceptance:

- Valid `accurate + vad` runs end-to-end on Android.
- Error matrix remains deterministic.

---

### Phase 5: iOS parity implementation

Files:

- `ios/alignment/bridge/SherpaOnnx+Alignment.mm`
- `ios/alignment/core/AlignmentBridgeUtils.mm/.h` (if needed)

Tasks:

- Mirror Android constrained accurate implementation.
- Match diagnostics and error mapping semantics.
- Ensure behavioral parity for:
  - empty anchors
  - mismatched counts
  - invalid buffer kind/state

Acceptance:

- iOS behavior is semantically equivalent to Android for all tested matrix cases.

---

### Phase 6: Example app update

Files:

- `example/src/screens/generate-timestamp/GenerateTimestampScreen.tsx`
- related styles if needed

Tasks:

- Add explicit run path for `accurate + vad` in mode/options UX.
- Reuse existing VAD model + auto segmentation-buffer setup.
- Surface diagnostics in result view (so constrained accurate execution is observable).

Acceptance:

- Example demonstrates all three relevant paths:
  - accurate (plain)
  - vad (standalone)
  - accurate + vad (constrained accurate)

---

### Phase 7: Docs hard cut completion

Files:

- `docs/alignment.md`
- `docs/migration/vad/vad-integration-plan.md`
- `docs/migration/alignment/offline-alignment-pipeline-spec.md`
- optional migration index docs

Tasks:

- Remove "prepared/not implemented" wording for this combo.
- Document final behavior matrix and diagnostics.
- Keep buffer-first guidance and app-layer subtitle derivation.

Acceptance:

- Public docs match runtime reality exactly.

---

### Phase 8: Verification and release gate

Required checks:

- `yarn run tsc --noEmit`
- `npx tsc --noEmit --project example/tsconfig.json`
- Lint changed files
- Manual matrix tests (JS + Android + iOS parity)

Manual matrix minimum:

- valid accurate without segmentation
- valid vad standalone
- valid accurate + vad
- invalid accurate + segmentation missing buffer
- invalid accurate + wrong segmentation buffer kind
- invalid accurate + empty/malformed segmentation payload
- invalid output buffer state/kind
- deterministic diagnostics presence in successful constrained runs

---

## Open questions to resolve before implementation

The following decisions should be answered explicitly before coding:

None.

---

## Recommended decision order

1. Implement phases 2-8 in order.

This keeps the cold-cut release deterministic and reviewable.

