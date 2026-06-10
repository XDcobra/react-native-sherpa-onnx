# Implementation plan — VAD offline Phase 2: `onProgress` (`OrchestrationProgress`)

**Goal:** Emit **`OrchestrationProgress`** **before each** `runVadOffline` invocation in the **segmented** offline path, with semantics **identical** to [`reportProgress`](../../../src/pipeline/offlineOrchestrator.ts) / STT segmented **`onProgress`**.

**Prerequisites:** [Phase 1](./impl-vad-offline-phase-1-segment-loop.md) complete.

---

## 1. Wiring

### 1.1 Reuse alignment helper (preferred)

- Import **`createAlignmentProgressSession`** from [`src/alignment/progress.ts`](../../../src/alignment/progress.ts) **or** extract shared **`createOrchestrationStyleProgressSession`** to `src/pipeline/progressUtils.ts` if VAD must not depend on alignment package — **decision:** avoid circular deps (`vad` → `alignment` odd). **Preferred:** move tiny session factory to **`src/pipeline/progressSession.ts`** used by both alignment and VAD; **or** duplicate 5 lines in `vad` (acceptable if duplication is smaller than new module). Document chosen approach in ADR-002 amendment.

Implementation note: v1 uses a tiny local session helper in `src/vad/engine.ts` to avoid introducing a `vad` -> `alignment` dependency and to keep Phase-2 churn minimal.

### 1.2 Session lifecycle

- `startedAtMs = Date.now()` at **entry** to offline `process` (segmented branch only).
- `totalSegments = speechSegments.length` after segmentation list is final.
- For `i` in `0 .. totalSegments-1`, **before** `runVadOffline` for segment `i`:
  - `emitStep(i, totalSegments, segmentDurationMs)` where `segmentDurationMs` from segment metadata (`durationMs` or samples / sample rate).

### 1.3 `segmentation.mode === 'off'`**

- **Optional:** single-shot `emitStep(0, 1, fullBufferDurationMs)` when `onProgress` provided — **match product call:** STT single transcribe path does **not** call `onProgress` today (see [`stt/index.ts`](../../../src/stt/index.ts) lines 461–470). **Recommendation:** **no** `onProgress` for single-pass VAD to stay consistent with STT single-pass. Document in user docs.

---

## 2. `abortSignal`

- If **`abortSignal`** added in Phase 0 types: between progress for segment `i` and native call, check **`signal.aborted`** and throw / return partial result per ADR — align with `OrchestrationConfig.abortSignal` behaviour in orchestrator.
- If **not** in scope: omit; progress plan unchanged.

---

## 3. Tests

| Test | Assertion |
| --- | --- |
| Segmented, 3 segments, `onProgress` set | 3 callbacks; indices 0,1,2; monotonic `elapsedMs`; `fraction` matches formula. |
| `onProgress` undefined | 0 calls. |
| Native throws on segment 1 | One progress event for `i=0`, then error (or two events if emit-before — document). |

---

## 4. Documentation

- Update **`docs/vad-streaming.md`** (or **`vad-offline.md`**) with **progress table** mirroring STT offline segmented story.
- Link [migration README](./README.md).

---

## 5. Exit criteria

- [x] `onProgress` matches orchestrator field semantics on segmented path.
- [x] Documented parity / intentional difference for single-pass (`off`) path.
- [x] Tests green.

---

## 6. Non-goals

- Live pipeline `onProgress`.
- Sample-level progress.
