# Implementation plan — VAD offline Phase 1: Segment + loop

**Goal:** When **`VADOfflineRunOptions.segmentation.mode !== 'off'`**, split **`audioIn`** into **speech segments**, run offline VAD work **per segment**, and **merge** results into **`segmentOut`** with the **same observable outcome shape** as today’s single-pass where feasible.

**Prerequisites:** [Phase 0](./impl-vad-offline-phase-0-api-design.md) ADR approved; native contract (slice vs temp buffer) decided.

---

## 1. Reference implementation

**Pattern model:** [`runOfflineAudioToTextPipeline`](../../../src/pipeline/offlineOrchestrator.ts) + offline STT batch path in [`src/stt/index.ts`](../../../src/stt/index.ts) (lines ~443–495).

**Reuse:**

- **`validateSegmentationConfig`** (or equivalent) with `featureName: 'offline VAD'` and VAD-appropriate **default policy** (ADR-002 values — likely speech-energy defaults similar to STT unless VAD team specifies shorter `minSegmentMs`).
- **`segmentOfflineBuffer`** / **`getSegments`** from [`src/segment`](../../../src/segment) — **domain `speech`**, same as STT orchestration.

---

## 2. Implementation steps (`src/vad/engine.ts`)

### 2.1 Option normalisation

At start of offline `process` branch:

1. Parse `options?.segmentation` — default **`mode: 'off'`** when missing.
2. If **`off`:** existing single **`runVadOffline`** call — **no** structural change.
3. If **`auto`:** proceed to §2.2.

### 2.2 Segmentation

1. Resolve **`audioIn`** to `bufferId` (already done in engine).
2. Call **`segmentOfflineBuffer`** with policy from validated config; obtain **speech** `Segment[]` via **`getSegments`** (grep STT for exact sequence — typically segment then list).
3. **Empty segment list:** define behaviour in ADR — options: (a) treat as silence → single empty result; (b) run legacy full-buffer pass; **pick one** and test.

### 2.3 Per-segment execution (no `onProgress` yet — Phase 2)

For each segment `i` in order:

1. **Materialise input slice** per ADR-002: either native sub-range API or `getOfflineAudioBufferSamplesSlice` + **`createOfflineAudioBufferFromSamples`** temp buffer.
2. **Output target:** either append to a **temporary offline segment buffer** per call then merge, or **native** supports writing into `segmentOut` with offset — follow spike.
3. Invoke **`SherpaOnnx.runVadOffline`** for that slice with same runtime tuning options as today’s single call (thread through options subset).

### 2.4 Merge / finalise

- **Summary fields** (`chunksProcessed`, `unitsRead`, …): **define aggregation rules** in ADR (sum counters; `segmentCount` = total appended segments).
- Ensure **`VADOfflineResult.segmentBufferId`** remains the caller’s **`segmentOut`** buffer id.

---

## 3. Files likely touched

| File | Change |
| --- | --- |
| [`src/vad/engine.ts`](../../../src/vad/engine.ts) | Branching, loop, merge |
| [`src/vad/types.ts`](../../../src/vad/types.ts) | Options / result types from Phase 0 |
| [`src/segment/`](../../../src/segment) | Possibly no change if API sufficient |
| Tests | `src/vad/__tests__/...` |

---

## 4. Tests

| Case | Expectation |
| --- | --- |
| `segmentation` absent | Single `runVadOffline` (spy count === 1). |
| `segmentation.mode === 'off'` | Same. |
| `segmentation.mode === 'auto'` + synthetic audio with 2 speech islands | `runVadOffline` called **twice** (or per ADR), merged segment count matches golden. |
| Live `segmentOut` + segmented mode | If unsupported, clear **throw** with `VAD_INVALID_ARGUMENT` (document). |

---

## 5. Performance mitigations (implement or document)

- **Minimum segment duration** / merging micro-segments — align with segmentation policy knobs; document if double `runVadOffline` overhead is high.

---

## 6. Exit criteria

- [ ] Segmented path functionally correct on CI device/simulator tests (or mocked native).
- [ ] Default path unchanged for existing apps.
- [ ] No `onProgress` requirement yet (Phase 2).

---

## 7. Handoff to Phase 2

- Loop body must have a **stable `totalSegments`** count **before** first native call (orchestrator contract) — typically **`speechSegments.length`**. If dynamic discovery, fall back to alignment Phase-0 **single-shot** rule until counts known.
