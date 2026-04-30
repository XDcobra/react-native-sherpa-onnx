# Sub-Plan 01 — Public API Contract (`AlignmentEngine`)

## Status
- **Planned**
- Depends on: none (entry phase)
- Prerequisite for: sub-02, sub-03, sub-04, sub-05, sub-07

---

## 1. Scope

Define and ship the **target public surface** of the alignment feature with no behavior change for non-accurate modes:

- Introduce `AlignmentEngine` factory + class.
- Move `alignTextToAudio` from a freestanding function to an engine method.
- Lock option types around `modelPath: ModelPathConfig`.
- Define error/warning code catalog (consumed by all later sub-plans).
- Keep rows 1, 2, 3, 5 byte-equivalent for callers migrating call sites.

---

## 2. Non-Goals

- No linker logic (sub-02).
- No Strategy A or B implementation (sub-03/04).
- No new native model paths.
- No native parity work beyond keeping current behavior intact.

---

## 3. Current State (Ist)

- `src/alignment/index.ts` exports a freestanding `alignTextToAudio` and supporting types.
- `src/alignment/alignTextToAudio.ts` builds native options and dispatches to `SherpaOnnx.alignOfflineTextToAudio`.
- `src/alignment/types.ts` already uses `modelPath: ModelPathConfig` for `AlignTextToAudioOptionsAccurate`.
- Native call site reads accurate-mode `modelPath` via `AlignmentOptionParsers.kt` / `AlignmentBridgeUtils.mm`.
- No engine abstraction; no per-engine state lifecycle.
- Public modes overview (`alignment-public-modes-plan.md`) enumerates target API and locked decisions.

---

## 4. Target State (Soll)

### 4.1 Public surface (TS)

```typescript
// src/alignment/index.ts
export { createAlignment } from './engine';
export type { AlignmentEngine } from './engine';
export type {
  AlignTextToAudioOptions,
  AlignTextToAudioOptionsAccurate,
  AlignTextToAudioOptionsEstimated,
  AlignTextToAudioOptionsProportional,
  AlignTextToAudioOptionsVad,
  AlignTextToAudioWriteResult,
  AlignmentVadSegmentationConfig,
  AlignmentChunkTimeline,
  AlignmentDetectResult,
  AlignmentGranularity,
  AlignmentModelType,
  AlignmentTimestamp,
  AlignmentTimingMode,
} from './types';
// alignTextToAudio is NOT exported anymore (hard cut).
```

### 4.2 Engine class

```typescript
// src/alignment/engine.ts
export interface AlignmentEngineOptions {
  // reserved for future engine-level config (caching, telemetry hooks, …).
  // intentionally empty in v1; presence of the type future-proofs the API.
}

export interface AlignmentEngine {
  alignTextToAudio(
    textIn: OfflineTextBufferRef,
    audioIn: OfflineAudioBufferRef,
    segmentOut: OfflineSegmentBufferRef,
    options: AlignTextToAudioOptions
  ): Promise<AlignTextToAudioWriteResult>;
  destroy(): Promise<void>;
}

export function createAlignment(
  options?: AlignmentEngineOptions
): AlignmentEngine;
```

### 4.3 Options shape (relevant excerpts)

- `AlignTextToAudioOptionsAccurate`
  - `mode: 'accurate'`
  - `modelPath: ModelPathConfig` (required)
  - `granularity: 'token' | 'word'`
  - `language?: string`
  - `segmentation?:` `{ mode: 'off' }` | `{ mode: 'auto' }` (auto enables row 4)
  - `mappingStrategy?: 'asr_mediated' | 'chunked_forced_ctc'` (only meaningful when `segmentation.mode === 'auto'`)
  - `asr?: { hypothesisTextBuffer: OfflineTextBufferRef }` (required for `'asr_mediated'`)
- `AlignTextToAudioOptionsProportional` / `Estimated` — unchanged shape.
- `AlignTextToAudioOptionsVad` — unchanged shape.

### 4.4 Behavior contract

- `createAlignment()` MUST be cheap (no model load).
- `engine.alignTextToAudio()`:
  - validates option shape against the matrix in 4.3;
  - dispatches the same way the freestanding function does today for rows 1, 2, 3, 5;
  - rows 4a/4b are accepted at the option layer but NOT implemented in P1 — they MUST throw `ALIGNMENT_NOT_IMPLEMENTED` (placeholder code) until sub-03/04 land. This guarantees no silent partial behavior.
- `engine.destroy()` is idempotent and returns when native resources (if any) have been released.

---

## 5. Public Contract / API Changes

| Change | Type | Notes |
|--------|------|-------|
| `createAlignment` (new) | Add | Default export path forward |
| `AlignmentEngine` (new) | Add | Class/interface |
| `alignTextToAudio` freestanding export | **Remove** (hard cut) | Replaced by engine method |
| `assertAlignmentGranularityForMode` re-export | **Remove from public** | Internal-only after P1 |
| `AlignTextToAudioOptionsAccurate.mappingStrategy` | Add | Strict enum |
| `AlignTextToAudioOptionsAccurate.asr` | Add | Required only when strategy is `'asr_mediated'` |
| `AlignTextToAudioOptionsAccurate.segmentation.mode` | Tighten to `'off' \| 'auto'` | No legacy values |
| Caller-supplied `modelPath` | Already `ModelPathConfig` | Reaffirm; reject raw `string` shape with explicit error |

---

## 6. Native + JS Implementation Tasks (Checklist)

### TypeScript

- [ ] Create `src/alignment/engine.ts`:
  - [ ] `createAlignment(options?: AlignmentEngineOptions)` returns object implementing `AlignmentEngine`.
  - [ ] `engine.alignTextToAudio(...)` validates options → calls into `runAlignTextToAudio` (renamed internal).
  - [ ] `engine.destroy()` no-op in v1; returns resolved promise.
- [ ] Rename current `alignTextToAudio` to internal `runAlignTextToAudio` in `src/alignment/alignTextToAudio.ts`; remove default export.
- [ ] Update `src/alignment/types.ts`:
  - [ ] Tighten `segmentation` discriminated union for accurate.
  - [ ] Add `mappingStrategy` and `asr.hypothesisTextBuffer`.
  - [ ] Public re-export adjustments per 4.1.
- [ ] Update `src/alignment/index.ts`:
  - [ ] Drop freestanding `alignTextToAudio` export.
  - [ ] Add `createAlignment` + `AlignmentEngine` re-exports.
  - [ ] Keep `detectAlignmentModel` unchanged.

### Validation layer (TS)

- [ ] Strict union validation for `mode`, `mappingStrategy`, `granularity`.
- [ ] Reject raw `string` for accurate `modelPath` with `ALIGNMENT_MODEL_PATH_INVALID`.
- [ ] Enforce: if `mode === 'accurate'` and `segmentation?.mode === 'auto'`:
  - if `mappingStrategy === 'asr_mediated'` → require `asr.hypothesisTextBuffer`.
  - if `mappingStrategy === 'chunked_forced_ctc'` → forbid `asr`.

### Native

- [ ] No native changes in this sub-plan — existing rows 1/2/3/5 continue to use current bridge entry.
- [ ] Add explicit JS-side gate: rows 4a/4b throw `ALIGNMENT_NOT_IMPLEMENTED` before reaching native; native path remains untouched.

---

## 7. Error Codes / Diagnostics

| Code | Layer | When |
|------|-------|------|
| `ALIGNMENT_OPTIONS_INVALID` | JS | Mode discriminator wrong / unknown enum |
| `ALIGNMENT_MODEL_PATH_INVALID` | JS | Accurate mode without `modelPath: ModelPathConfig` |
| `ALIGNMENT_GRANULARITY_INVALID` | JS | Granularity not allowed for selected mode |
| `ALIGNMENT_ASR_HYPOTHESIS_MISSING` | JS | Strategy A without `asr.hypothesisTextBuffer` |
| `ALIGNMENT_NOT_IMPLEMENTED` | JS | Strategy A/B requested before sub-03/04 ship |
| `ALIGNMENT_ENGINE_DESTROYED` | JS | Method called after `destroy()` |

> Codes are `error.message` prefix tokens; JS layer wraps with `Error` containing `code` field.

---

## 8. Test Plan (Jest, no E2E)

### Unit

- `src/alignment/__tests__/engine-create.test.ts`
  - createAlignment returns object with required methods.
  - destroy is idempotent.
- `src/alignment/__tests__/engine-options-validation.test.ts`
  - Each error code from §7 is produced for the documented input.
  - Granularity matrix (row × allowed granularity) covered.
- `src/alignment/__tests__/engine-no-freestanding-export.test.ts`
  - Imports from `src/alignment` MUST NOT expose `alignTextToAudio`.
  - Snapshot the exported keys.

### Integration

- `src/alignment/__tests__/engine-row-parity.test.ts`
  - For rows 1, 2, 3, 5: call native via mock and assert payload matches the previous freestanding caller’s payload byte-for-byte.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Hidden callers of `alignTextToAudio` break post-cut | Repo grep + lint rule (sub-06); release notes |
| Type drift between `types.ts` and engine | Single source of truth in `types.ts`; engine imports them |
| Accurate auto routes silently to old code | Explicit `ALIGNMENT_NOT_IMPLEMENTED` until P3/P4 land |
| `engine.destroy()` lifecycle becomes leaky in P2+ | Reserve native handle slot now even if unused |

---

## 10. Exit Criteria (DoD)

- [ ] All TS tasks in §6 done.
- [ ] All Jest tests in §8 green.
- [ ] No remaining import of `alignTextToAudio` from `src/alignment` outside `src/alignment/`.
- [ ] `docs/migration/alignment/alignment-public-modes-plan.md` cross-links to this sub-plan.
- [ ] Overview `Fortschritts-Tracking` flipped to `Completed`.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| Locked option matrix | `alignment-public-modes-plan.md` | Source of truth |
| ModelPathConfig | `src/utils` (`resolveModelPath`) | Already in use |

| Blocks | Reason |
|--------|--------|
| sub-02 | Linker is consumed via engine method |
| sub-03 | Strategy A wires through engine |
| sub-04 | Strategy B wires through engine |
| sub-05 | Native parity work piggybacks on engine surface |
| sub-07 | Docs & cutover assume engine API exists |
