# Implementation plan — Alignment Phase 1: API surface

**Goal:** Add optional **`onProgress?: (progress: OrchestrationProgress) => void`** to **`AlignTextToAudioOptions`** (all modes), re-export or import **`OrchestrationProgress`** from the canonical definition, and establish a **single internal helper** for progress math — **without** emitting events from drivers yet (callbacks must remain **absent** when `onProgress` is omitted; when provided in Phase 1, behaviour may still be **no events** until Phase 2 lands, *or* Phase 1 may wire **native single-shot** paths only — pick one branch below).

**Normative references:** [ADR-001](./ADR-001-alignment-offline-progress-strategy.md), [phase-0](./phase-0-alignment-progress-semantics.md), [`offlineOrchestrator.ts` — `reportProgress`](../../../src/pipeline/offlineOrchestrator.ts).

---

## 1. TypeScript public API

### 1.1 `OrchestrationProgress` import

- **Canonical type:** `export interface OrchestrationProgress` in `src/pipeline/offlineOrchestrator.ts`.
- **Alignment package:** In `src/alignment/types.ts` (or `src/alignment/index.ts`), either:
  - `import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';` and re-export `export type { OrchestrationProgress };`, **or**
  - export from `src/alignment/index.ts` only (avoid circular imports — `alignment` must not pull heavy runtime from `pipeline` if that creates cycles; **type-only** imports are safe).

### 1.2 Extend `AlignTextToAudioOptions` discriminated union

Today: `AlignTextToAudioOptionsProportional | Estimated | Accurate | Vad` in [`src/alignment/types.ts`](../../../src/alignment/types.ts).

**Recommended pattern** (mirrors optional callbacks on other features):

```ts
// types.ts
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';

export type AlignmentProgressCallbacks = {
  /** Fires at start of each progress step; see docs. Optional. */
  onProgress?: (progress: OrchestrationProgress) => void;
};

export type AlignTextToAudioOptionsProportional = {
  mode: 'proportional';
  // ...existing fields
} & AlignmentProgressCallbacks;
// repeat & for estimated, accurate, vad variants
```

- **Do not** add `onProgress` to `buildNativeOptions` payloads — native `Record<string, unknown>` must never receive functions.
- **JSDoc** on `AlignmentProgressCallbacks.onProgress`: non-goals from ADR (not sample-accurate; not alignment warnings; timing = start of step — full table in phase-0).

### 1.3 `AlignTextToAudioFn` signature

- No change to arity; `options` already carries the union. Ensure **exported** `AlignTextToAudioOptions` in `src/alignment/index.ts` includes the new optional field story.

---

## 2. Internal helper: `reportAlignmentProgress` (Phase 1 deliverable)

**New file (suggested):** `src/alignment/progress.ts`

**Responsibilities:**

1. Hold **`startedAtMs`** (`number`, from `Date.now()` at **entry** to `runAlignTextToAudio` or driver entry — Phase 2 clarifies; Phase 1 can define helper as pure function).
2. Expose **`emit(currentSegment, totalSegments, currentSegmentDurationMs)`** that:
   - no-ops if `onProgress` is `undefined`;
   - otherwise calls `onProgress` with:
     - `fraction = totalSegments > 0 ? currentSegment / totalSegments : 1` (**identical** to [`reportProgress`](../../../src/pipeline/offlineOrchestrator.ts) lines 281–288).
     - `elapsedMs = Date.now() - startedAtMs`.

**API sketch:**

```ts
export function createAlignmentProgressSession(
  onProgress: ((p: OrchestrationProgress) => void) | undefined,
  startedAtMs: number = Date.now()
): {
  emitStep(
    currentSegment: number,
    totalSegments: number,
    currentSegmentDurationMs: number
  ): void;
};
```

- **Single source of truth** for fraction math prevents drift vs STT.
- **Tests (Phase 1):** unit test `createAlignmentProgressSession` with fake timers or fixed `startedAtMs` + mocked `Date.now` if needed; assert fraction edge cases (`totalSegments === 0` → fraction `1`).

---

## 3. Wiring in `runAlignTextToAudio`

**File:** [`src/alignment/alignTextToAudio.ts`](../../../src/alignment/alignTextToAudio.ts)

1. At the **top** of `runAlignTextToAudio`, capture `options.onProgress` and `startedAtMs = Date.now()` (or delegate to session factory once per invocation).
2. **Strip** `onProgress` before any hypothetical serialization — today `buildNativeOptions` only picks known keys; **ensure** no code path spreads `...options` into native payloads.
3. **Branch A (minimal Phase 1):** Pass `onProgress` / session into **`runAccurateAsrMediated`** / **`runAccurateChunkedForcedCtc`** as optional args but **drivers ignore** until Phase 2 — simplest CI story.
4. **Branch B (incremental value):** For the **`SherpaOnnx.alignOfflineTextToAudio`** path (proportional, estimated, vad after early exits resolved, accurate non-auto), call **single-shot** `emitStep(0, 1, 0)` **once** at start **before** native call, when `onProgress` is defined — matches phase-0 rows for `totalSegments === 1`. **Requires** per-path audit so VAD zero-anchor early return does **not** emit (phase-0: zero anchors → no work, **no** progress requirement for “started” — confirm table: `totalSegments` 1 if zero anchors — re-read phase-0 row for vad).

**Phase-0 VAD row:** “`1` if zero anchors (no work)” — interpret as **either** no callback **or** one callback with `totalSegments === 1`; implementation plan: **prefer zero callbacks** for zero-anchor no-op success to avoid fake “progress” on no-op. Document in Phase 3 doc if adjusted.

**Recommendation for Phase 1:** **Branch A** only (types + helper + pass-through types to drivers’ input interfaces without calls) **unless** product wants immediate single-shot for native path — then **Branch B** for native path only.

---

## 4. Driver input types (preparation)

- **`RunAccurateChunkedForcedCtcInput`** ([`chunkedForcedCtc/driver.ts`](../../../src/alignment/chunkedForcedCtc/driver.ts)): add optional `onProgress?: ...` **or** optional `progress?: ReturnType<typeof createAlignmentProgressSession>` to avoid threading raw callback.
- **`RunAccurateAsrMediated` input:** same.
- **`runAlignTextToAudio`** passes through from `options` when calling drivers.

---

## 5. Validation

**File:** [`src/alignment/engine.ts`](../../../src/alignment/engine.ts) — `validateAlignTextToAudioOptions`

- If `onProgress` present: must be **function** or **undefined**; reject non-functions with `ALIGNMENT_OPTIONS_INVALID` (consistent with other engines’ callback validation patterns — grep `onProgress` validation in `src/stt` if exists).

---

## 6. Tests (Phase 1)

| Test | Location |
| --- | --- |
| `createAlignmentProgressSession` fraction / elapsedMs | `src/alignment/__tests__/progress.test.ts` (or colocated) |
| `validateAlignTextToAudioOptions` rejects `onProgress: 123` | alignment engine / types tests |
| Regression: `onProgress` undefined → native path unchanged | existing integration tests; add one explicit assert **no** `onProgress` key in native bridge mocks if tests spy on options |

---

## 7. Docs (minimal for Phase 1)

- [`alignment-offline.md`](../../alignment-offline.md): one sentence that **`onProgress`** is optional and **may** not fire for all modes until phased rollout (cross-link phase-2 plan).
- Do **not** duplicate full semantics table here (Phase 4 consolidates).

---

## 8. Exit criteria (Definition of Done)

- [ ] `AlignTextToAudioOptions` exposes optional `onProgress` with **`OrchestrationProgress`** type publicly.
- [ ] `OrchestrationProgress` exported from alignment public entry (`react-native-sherpa-onnx/alignment` or root types — follow existing export map in `package.json` / `src/alignment/index.ts`).
- [ ] `src/alignment/progress.ts` exists with orchestrator-identical fraction semantics + unit tests.
- [ ] No native / JSON payload includes function values.
- [ ] CI green; no behaviour change for callers who omit `onProgress` (unless Branch B explicitly chosen and tested).

---

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Circular import alignment ↔ orchestrator | Use `import type` only for `OrchestrationProgress`. |
| Bundle size | Type-only import strips at emit; runtime helper is tiny. |
| Callback throws | Match orchestrator: **document** caller must not throw; optional try/catch only if STT does — grep before adding. |
