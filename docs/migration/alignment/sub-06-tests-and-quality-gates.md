# Sub-Plan 06 — Tests & Quality Gates

## Status
- **Planned**
- Depends on: sub-01, sub-02, sub-03, sub-04, sub-05
- Prerequisite for: sub-07 (cutover gate)

---

## 1. Scope

Define and ship the **complete Jest matrix** for the alignment migration. Define the contract-test layer, the parity fixture format, and the gates that block release.

Explicitly: **no E2E**. Real models on real devices are out of scope for this phase.

---

## 2. Non-Goals

- No on-device benchmark suite.
- No CI infrastructure changes outside tests already wired to the existing Jest runner.
- No screenshot / UI tests.
- No new SDK code; this sub-plan is consumer of all earlier plans.

---

## 3. Current State (Ist)

- Existing alignment Jest tests cover the freestanding `alignTextToAudio` legacy surface.
- No tests for `AlignmentEngine`, linker, Strategy A driver, Strategy B driver, or native bridge call shapes for the new methods.

---

## 4. Target State (Soll)

A coherent test matrix grouped per sub-plan with shared fixtures.

### 4.1 Shared fixtures

```
src/alignment/__tests__/fixtures/
  modes/
    proportional-en-word.json
    estimated-en-token.json
    accurate-row3-en.json
  linker/
    short-en.json                 // R, H tokens with timestamps, anchors
    partial-coverage-en.json
    missing-timestamps-en.json
  strategyA/
    pipeline-en.json              // anchors + R + linker mock outputs + native mock outputs
  strategyB/
    pipeline-en.json              // anchors + R + native mock outputs (consumed counts)
    stuck-en.json
  parity/
    case-01.json                  // numeric expectations within tolerance
```

### 4.2 Mocking strategy

- `jest.mock('../../NativeSherpaOnnx', ...)` to isolate from native.
- Buffer refs are typed handles; tests use a thin `OfflineBufferTestHarness` already used in segmentation tests.
- Linker integration tests stub `runLinker` to deterministic `LinkerResultV0`.

### 4.3 Contract tests

Contract tests assert shape and codes — independent of implementation:

- Public exports (sub-01): no `alignTextToAudio`; engine surface present.
- Native spec shape (sub-05): expected method names + payload structure.
- Error code emission (every documented code in sub-01..05) — at least one positive test per code.

---

## 5. Public Contract / API Changes

- None.

---

## 6. Native + JS Implementation Tasks (Checklist)

### Test files to create

#### sub-01 (Public API)

- [ ] `src/alignment/__tests__/engine-create.test.ts`
- [ ] `src/alignment/__tests__/engine-options-validation.test.ts`
- [ ] `src/alignment/__tests__/engine-no-freestanding-export.test.ts`
- [ ] `src/alignment/__tests__/engine-row-parity.test.ts`

#### sub-02 (Linker)

- [ ] `src/alignment/linker/__tests__/normalize.test.ts`
- [ ] `src/alignment/linker/__tests__/dtw.test.ts`
- [ ] `src/alignment/linker/__tests__/anchorMap.test.ts`
- [ ] `src/alignment/linker/__tests__/confidence.test.ts`
- [ ] `src/alignment/linker/__tests__/runLinker.test.ts`
- [ ] `src/alignment/linker/__tests__/runLinker-missing-timestamps.test.ts`

#### sub-03 (Strategy A)

- [ ] `src/alignment/strategyA/__tests__/driver-options.test.ts`
- [ ] `src/alignment/strategyA/__tests__/driver-coverage.test.ts`
- [ ] `src/alignment/strategyA/__tests__/driver-offset.test.ts`
- [ ] `src/alignment/strategyA/__tests__/driver-pipeline.test.ts`
- [ ] `src/alignment/strategyA/__tests__/missing-timestamps.test.ts`

#### sub-04 (Strategy B)

- [ ] `src/alignment/strategyB/__tests__/cursor.test.ts`
- [ ] `src/alignment/strategyB/__tests__/driver-options.test.ts`
- [ ] `src/alignment/strategyB/__tests__/driver-progress.test.ts`
- [ ] `src/alignment/strategyB/__tests__/driver-pipeline.test.ts`
- [ ] `src/alignment/strategyB/__tests__/driver-stuck.test.ts`
- [ ] `src/alignment/strategyB/__tests__/native-spec.test.ts`

#### sub-05 (Native bridge & parity)

- [ ] `src/alignment/__tests__/native-spec-shape.test.ts`
- [ ] `src/alignment/__tests__/native-bridge-slice-call.test.ts`
- [ ] `src/alignment/__tests__/native-bridge-error-mapping.test.ts`

#### Cross-cutting

- [ ] `src/alignment/__tests__/error-codes-catalog.test.ts`
  - Each code from sub-01..05 has at least one positive test asserting it is produced.

### Lint / static gates

- [ ] Add a repo-wide grep test that fails CI when `alignTextToAudio` is imported as a value from `'react-native-sherpa-onnx'` outside `src/alignment/`.
- [ ] Add a Jest test that snapshots `Object.keys(require('../index'))` to lock public surface.

---

## 7. Error Codes / Diagnostics

This sub-plan does not introduce new codes; it asserts every code produced by sub-01..05.

Catalog used by `error-codes-catalog.test.ts`:

```
ALIGNMENT_OPTIONS_INVALID
ALIGNMENT_MODEL_PATH_INVALID
ALIGNMENT_GRANULARITY_INVALID
ALIGNMENT_ASR_HYPOTHESIS_MISSING
ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS
ALIGNMENT_NOT_IMPLEMENTED
ALIGNMENT_ENGINE_DESTROYED
ALIGNMENT_LINKER_INPUT_INVALID
ALIGNMENT_LINKER_FAILED
ALIGNMENT_LINKER_NO_MAPPING
ALIGNMENT_ANCHOR_OUT_OF_RANGE
ALIGNMENT_NATIVE_ACCURATE_FAILED
ALIGNMENT_FORCED_CTC_FAILED
ALIGNMENT_FORCED_CTC_STUCK
ALIGNMENT_MODEL_LOAD_FAILED
ALIGNMENT_NATIVE_UNKNOWN
OFFLINE_OOM
```

Warning codes (assert produced exactly when expected):

```
ALIGNMENT_PARTIAL_COVERAGE
ALIGNMENT_LOW_CONFIDENCE_UNIT_PRESENT
ALIGNMENT_ANCHOR_NO_PROGRESS
ALIGNMENT_RESIDUAL_TOKENS_REMAINING
```

---

## 8. Test Plan (Jest, no E2E)

This sub-plan **is** the test plan. Quality gate at completion:

| Gate | Pass condition |
|------|----------------|
| Public surface lock | Snapshot test green |
| Engine row parity (1, 2, 3, 5) | Engine path produces same native payload as legacy did |
| Linker determinism | Snapshot of `LinkerResultV0` stable across runs |
| Strategy A integration | Pipeline test green; offsets correct |
| Strategy B integration | Cursor + stuck + residual cases green |
| Native spec | Native method names + parameters present |
| Error catalog | All codes asserted at least once |

CI must run: `yarn jest src/alignment` with all suites green.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Snapshot churn from minor numerical drift | Use rounded values + tolerance assertions, not raw snapshots, for floats |
| Hidden flakiness from RNG / time | All tests deterministic; no `Date.now()` use without explicit fakes |
| Native mocks drift from real native | Spec-shape test + parity fixture format documented in sub-05 |
| Tests overweight on linker happy-path | Explicit failure-mode tests required (catalog enforced) |

---

## 10. Exit Criteria (DoD)

- [ ] All test files in §6 created and passing locally.
- [ ] `yarn jest src/alignment` exits 0.
- [ ] Public surface snapshot matches sub-01 §4.1.
- [ ] Error catalog test references **all** codes in §7.
- [ ] Overview tracking flipped to `Completed`.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| All earlier sub-plans implemented | sub-01..05 | Tests require code under test |
| Test fixtures format | sub-02..05 | Driver inputs/outputs |

| Blocks | Reason |
|--------|--------|
| sub-07 | Docs/cutover gates depend on test green |
