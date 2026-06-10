# Implementation plan — Alignment Phase 4: Parity, docs, release

**Goal:** Cross-link documentation, optional **progress matrix** mention, and ship notes so SDK consumers discover **`AlignTextToAudioOptions.onProgress`** and understand **per-mode** semantics.

**Prerequisites:** [Phase 3](./impl-alignment-phase-3-remaining-modes.md) complete (all modes implemented or explicitly deferred with doc).

---

## 1. Documentation sweep

### 1.1 [`docs/alignment-offline.md`](../../alignment-offline.md)

- Expand **Offline progress (`onProgress`)** section with:
  - **Per-mode table** (can be a slim copy of phase-0 or “see phase-0 for normative table” + one example snippet).
  - **Example:** `alignTextToAudio(..., { mode: 'accurate', ..., onProgress: (p) => { ... } })`.
  - **Caveats:** early exit / `break` in chunked path may leave `fraction < 1`; not waveform-level.

### 1.2 [`docs/feature-pipelines.md`](../../feature-pipelines.md)

- In **Alignment offline patterns** (§~202): add bullet — optional **`onProgress`** with **`OrchestrationProgress`**, link to `alignment-offline.md` + [phase-0](./phase-0-alignment-progress-semantics.md).
- Optional: add row to a “Offline progress” mini-table if one exists for STT/TTS; else single bullet.

### 1.3 [`docs/streaming-pipelines-overview.md`](../../streaming-pipelines-overview.md) (if present)

- One sentence: offline alignment progress uses **`OrchestrationProgress`**; streaming alignment N/A; link migration README.

### 1.4 Package / API extract

- If repo uses **TypeDoc** or hand-written API docs, add `onProgress` to alignment type pages.
- **`src/alignment/index.ts`:** ensure `OrchestrationProgress` in export list for consumers who tree-shake types from alignment entry.

---

## 2. Release note (CHANGELOG or release doc)

**Suggested entry:**

- **Added:** optional **`onProgress`** on **`AlignTextToAudioOptions`**, payload **`OrchestrationProgress`**, aligned with offline orchestrator timing (event at **start** of each progress step).
- **Semantics:** mode-dependent `totalSegments`; see docs.
- **Compatibility:** optional field — existing callers unchanged.

---

## 3. Optional internal diagram

- Mermaid: `runAlignTextToAudio` → drivers / native → `onProgress` hooks (developer doc only, e.g. under `docs/migration/...` or `docs/internal/` if policy allows). **Skip** if no internal doc folder policy.

---

## 4. Quality gates

- [ ] `yarn test` / `npm test` (project default) green for alignment + progress tests.
- [ ] Lint: no `any` introduced for `onProgress`.
- [ ] **Size / perf:** progress callback not allocated per tick beyond plain object (reuse object **not** required unless profiling shows issue).

---

## 5. Exit criteria

- [ ] All README Phase 4 deliverables checked.
- [ ] Links from [migration README](./README.md) to user-facing docs verified (no 404).
- [ ] CHANGELOG or equivalent updated.

---

## 6. Post-release (out of scope for Phase 4)

- Central **“Progress matrix”** page listing STT / TTS / Enhancement / Alignment / (future) VAD offline — README §5 optional follow-up.
