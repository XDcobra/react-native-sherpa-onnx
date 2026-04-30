# Sub-Plan 03 — Accurate / Strategy A Integration (ASR-mediated)

## Status
- **Planned**
- Depends on: sub-01, sub-02
- Prerequisite for: sub-05 (parity), sub-06 (test matrix), sub-07 (docs)

---

## 1. Scope

Wire **row 4a** end-to-end:

```
mode: 'accurate'
segmentation: { mode: 'auto' }
mappingStrategy: 'asr_mediated'
asr.hypothesisTextBuffer: <STT output with timestamps>
```

Pipeline:

1. Compute anchors from `audioIn` via SegmentationEngine (caller provides via attached engine; this sub-plan does NOT segment audio itself).
2. Run **linker** (sub-02) with anchors + R + H → `LinkerResultV0`.
3. For each anchor whose `LinkerMappingUnit`s cover non-empty R:
   - Slice PCM for the anchor.
   - Run native `AlignAccurateFromPcm` per slice with the unit's R substring.
   - Convert returned token/word timestamps from local-to-anchor → global timeline.
4. Append per-anchor results into `segmentOut` as `AlignedSegment` with `linkType: 'alignment'`.

---

## 2. Non-Goals

- No Strategy B logic (sub-04).
- No support for missing-timestamp hypotheses; hard fail with explicit code.
- No offline VAD here; anchor production is upstream.
- No silent fallback to row 3 ("full-buffer CTC") when linker fails.

---

## 3. Current State (Ist)

- Native `AlignAccurateFromPcm` exists for full-buffer accurate alignment; no chunked driver, no anchor support.
- `src/alignment/alignTextToAudio.ts` accepts a `segmentation` option but the accurate auto branch is currently dispatched as `ALIGNMENT_NOT_IMPLEMENTED` after sub-01 lands.
- Linker module from sub-02 ships rich result.

---

## 4. Target State (Soll)

### 4.1 Driver location

```
src/alignment/strategyA/
  driver.ts         // orchestrates linker → per-anchor CTC
  types.ts          // internal types (AnchorJob, AnchorResult)
  __tests__/
```

### 4.2 Driver outline

```typescript
async function runAccurateStrategyA(opts: {
  textIn: OfflineTextBufferRef;
  audioIn: OfflineAudioBufferRef;
  anchors: OfflineSegmentBufferRef;
  segmentOut: OfflineSegmentBufferRef;
  hypothesisTextBuffer: OfflineTextBufferRef;
  modelPath: string;          // already resolved
  granularity: 'token' | 'word';
  language?: string;
}): Promise<AlignTextToAudioWriteResult>;
```

Steps:

1. `linkerResult = await runLinker({...})` (sub-02).
2. Group `units` by `anchorIndex`.
3. For each anchor:
   - Compute R substring from concatenated `unit.refRange`s.
   - Read PCM slice for anchor → temporary `Float32Array` (zero-copy where possible via native side; see sub-05).
   - Invoke native `AlignAccurateFromPcm` (existing) with R substring + slice + `modelPath`, `granularity`, `language`.
   - Receive token/word timestamps **relative to slice start**.
   - Add anchor `startMs` offset → global timestamps.
   - Emit `AlignedSegment` to `segmentOut` (using existing segment add API).
4. Aggregate counts → `AlignTextToAudioWriteResult`.

### 4.3 Coverage policy

- If `linkerResult.units` cover < `100%` of R → no silent stretching; emit per-anchor `AlignedSegment`s only for what is covered. The result includes a top-level warning `ALIGNMENT_PARTIAL_COVERAGE` mirrored from the linker's `PARTIAL_COVERAGE` warning (no error).
- Caller decides if partial result is acceptable.

### 4.4 Hypothesis quality enforcement

- If H has tokens missing timestamps → linker rejects with `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` → driver re-throws unchanged.
- If linker returns 0 mapping units → `ALIGNMENT_LINKER_NO_MAPPING` (driver-emitted).

---

## 5. Public Contract / API Changes

- No new public types.
- Engine path: `engine.alignTextToAudio(...)` with `accurate + auto + asr_mediated` becomes valid.
- Result `AlignTextToAudioWriteResult` (existing) gains optional non-fatal `warnings: AlignmentWarning[]` (codes per §7). Existing fields unchanged.

---

## 6. Native + JS Implementation Tasks (Checklist)

### TypeScript

- [ ] `src/alignment/strategyA/driver.ts` per §4.2.
- [ ] `src/alignment/alignTextToAudio.ts`:
  - [ ] When `mode === 'accurate'` and `segmentation?.mode === 'auto'` and `mappingStrategy === 'asr_mediated'` → call `runAccurateStrategyA`.
- [ ] `src/alignment/types.ts`:
  - [ ] Add `AlignmentWarning` type + codes.

### Native

- [ ] **No new native function.** Reuse `AlignAccurateFromPcm` (Android C++ + iOS bridge) per anchor slice.
- [ ] Confirm slice read API exposes start/length in samples (sub-05 covers parity).
- [ ] Verify offset math is consistent for both platforms (unit test in sub-06).

---

## 7. Error Codes / Diagnostics

| Code | Layer | Meaning |
|------|-------|---------|
| `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` | linker | H must include per-token timestamps |
| `ALIGNMENT_LINKER_NO_MAPPING` | driver | Linker returned zero usable mapping units |
| `ALIGNMENT_LINKER_FAILED` | linker | Pass-through |
| `ALIGNMENT_ANCHOR_OUT_OF_RANGE` | driver | Anchor extends past audio length |
| `ALIGNMENT_NATIVE_ACCURATE_FAILED` | native | `AlignAccurateFromPcm` rejected the slice |

Warnings on result:

| Code | Severity | Cause |
|------|----------|-------|
| `ALIGNMENT_PARTIAL_COVERAGE` | warn | Linker reported partial coverage |
| `ALIGNMENT_LOW_CONFIDENCE_UNIT_PRESENT` | warn | One or more low-confidence linker units |

---

## 8. Test Plan (Jest, no E2E)

### Unit

- `src/alignment/strategyA/__tests__/driver-options.test.ts` — input validation (anchor empty, H empty).
- `src/alignment/strategyA/__tests__/driver-coverage.test.ts` — partial coverage emits warning, not error.
- `src/alignment/strategyA/__tests__/driver-offset.test.ts` — global timeline correctness for known anchor offsets.

### Integration (mocked native)

- `src/alignment/strategyA/__tests__/driver-pipeline.test.ts`:
  - Mocks `runLinker` to return a fixed `LinkerResultV0`.
  - Mocks native `AlignAccurateFromPcm` per slice with deterministic outputs.
  - Asserts `segmentOut` contains expected segments with global timestamps.
  - Asserts result counts match.

### Contract

- `src/alignment/strategyA/__tests__/missing-timestamps.test.ts` — H without timestamps rejects with `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Anchor↔H timing skew | Linker confidence + warning; do not stretch silently |
| PCM slice read overhead per anchor | Sub-05 provides slice-aware native API |
| Granularity mismatch (token vs word) between linker and native CTC | Driver passes the same `granularity` to both; tests cover both |
| Offset arithmetic bugs | Unit tests on offset math + parity test on iOS/Android |
| Long anchors close to model max length | Anchors come from segmentation policy; driver passes through; native error surfaces as `ALIGNMENT_NATIVE_ACCURATE_FAILED` |

---

## 10. Exit Criteria (DoD)

- [ ] All Jest tests in §8 green.
- [ ] Public API path (engine) for row 4a returns `AlignTextToAudioWriteResult` with correct counts.
- [ ] Driver emits exactly the documented error/warning codes — verified by contract tests.
- [ ] No call to native `AlignAccurateFromPcm` with the **full** PCM in this path (asserted in test).
- [ ] Overview tracking flipped to `Completed`.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| `runLinker` + `LinkerResultV0` | sub-02 | Mapping computation |
| Engine entrypoint | sub-01 | Public surface |
| Slice-aware PCM read | sub-05 | Slice reads to native |
| Anchor production | SegmentationEngine (already implemented) | Anchor list from caller |

| Blocks | Reason |
|--------|--------|
| sub-05 | Native parity test cases for row 4a |
| sub-06 | Test matrix |
| sub-07 | Docs example |
