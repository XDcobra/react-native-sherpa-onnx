# Sub-Plan 07 — Docs, Example & Cutover

## Status
- **Completed (2026-04-30)**
- Depends on: sub-01..06
- Last sub-plan in the alignment migration.

---

## 1. Scope

Finalize the migration:

- Rewrite `docs/alignment.md` to match the `AlignmentEngine` + locked decisions.
- Update example screen `example/src/screens/generate-timestamp/GenerateTimestampScreen.tsx` to use the engine API exclusively.
- Mark superseded sections in `accurate-vad-segmentation-high-level-plan.md` and other migration docs.
- Hard-cut: ensure there is no remaining reference to `alignTextToAudio` as a public symbol.
- Update `alignment_migration_overview.md` `Fortschritts-Tracking` to `Completed` once all gates from sub-06 pass.

---

## 2. Non-Goals

- No new SDK code, no new tests, no new behavior.
- No public migration guide writing for external users (locked decision: hard cut, no migration docs required).

---

## 3. Current State (Ist)

- `docs/alignment.md` was updated for `modelPath: ModelPathConfig` but still describes a freestanding `alignTextToAudio` style.
- `example/src/screens/generate-timestamp/GenerateTimestampScreen.tsx` calls `alignTextToAudio` directly.
- `accurate-vad-segmentation-high-level-plan.md` contains plan content that is now subsumed by the new sub-plans.

---

## 4. Target State (Soll)

### 4.1 `docs/alignment.md`

Sections (target outline):

1. Overview (modes 1–5).
2. Quickstart with `createAlignment` + `engine.alignTextToAudio`.
3. Per-mode option tables with `modelPath: ModelPathConfig` examples.
4. `asrMediated` (`asr_mediated`) walkthrough — points to `alignment-asr-mediated-ts-example.md`.
5. `chunkedForcedCtc` (`chunked_forced_ctc`) walkthrough.
6. Result schema (`AlignTextToAudioWriteResult`) including warnings.
7. Error catalog (links to sub-06 §7 catalog).
8. FAQ — including:
   - "Why no silent fallback?"
   - "What does OOM look like?"
   - "Why hard cut without legacy aliases?"
9. Cross-references to migration sub-plans (read-only links).

### 4.2 Example screen

`example/src/screens/generate-timestamp/GenerateTimestampScreen.tsx`:

- Replace top-level `alignTextToAudio` import with `createAlignment`.
- Lifecycle: create engine on mount, destroy on unmount.
- Each mode demo (proportional, estimated, accurate one-shot, accurate auto `asrMediated`, accurate auto `chunkedForcedCtc`, vad) becomes a button.
- Use `modelPath: { type: 'file', path: ... }`.

### 4.3 Superseded docs

- `docs/migration/alignment/accurate-vad-segmentation-high-level-plan.md`:
  - Top-of-file banner: "Superseded by `alignment_migration_overview.md` and sub-plans."
  - Keep buffer/anchor contract notes if they remain unique; otherwise cross-link.
- `docs/migration/alignment/alignment-public-modes-plan.md` keeps its role as **product surface source-of-truth**; update header to point at overview for migration sequencing.

### 4.4 Hard cut verification

- Repo grep: no production import of `alignTextToAudio` from public path.
- Public surface snapshot test from sub-06 stays green.
- Release notes (internal): mention engine API shift; no caller migration steps required because of hard cut policy.

---

## 5. Public Contract / API Changes

- None beyond what sub-01..05 already locked.
- Documentation only.

---

## 6. Native + JS Implementation Tasks (Checklist)

### Documentation

- [x] Rewrite `docs/alignment.md` per §4.1.
- [x] Update `docs/migration/alignment/alignment-public-modes-plan.md` header.
- [x] Update `docs/migration/alignment/accurate-vad-segmentation-high-level-plan.md` header banner.
- [x] Cross-link sub-plans in overview (already done in `alignment_migration_overview.md`).

### Example app

- [x] `GenerateTimestampScreen.tsx`:
  - [x] Use `createAlignment`.
  - [x] Show engine reuse across mode buttons.
  - [x] Add row 4a + 4b demo entries (gated behind a model-path selection UI element).

### Cleanup

- [x] Confirm no internal callers of `alignTextToAudio` outside `src/alignment/`.
- [x] Confirm no leftover legacy alias usage in production code paths (`alignmentModelPath`, `vadModelId`).
- [x] Update `CHANGELOG` (internal) with the breaking change note.

### Tracking

- [x] Flip `alignment_migration_overview.md` table rows to `Completed (YYYY-MM-DD)`.

---

## 7. Error Codes / Diagnostics

- No new codes.
- Documentation lists the canonical catalog (mirrors sub-06 §7).

---

## 8. Test Plan (Jest, no E2E)

- Public surface snapshot (sub-06) green.
- Repo-grep test (sub-06) green.
- No additional tests required.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Docs and code drift after release | Lock to `alignment_migration_overview.md`; review checklist requires sub-06 green |
| Example screen falls behind API | Sub-07 task list explicitly updates the screen as part of the migration |
| Old migration plans confuse readers | Banner + cross-links; supersede notes |

---

## 10. Exit Criteria (DoD)

- [x] `docs/alignment.md` rewritten and reviewed.
- [x] Example screen builds and runs against engine API on both platforms.
- [x] Repo greps pass (no leftover legacy names in production code paths).
- [x] Overview table fully `Completed`.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| Final API (engine) | sub-01 | Docs + example reference it |
| Linker schema | sub-02 | Docs reference rich result |
| `asrMediated` behavior | sub-03 | Docs walkthrough |
| `chunkedForcedCtc` behavior | sub-04 | Docs walkthrough |
| Native parity | sub-05 | Docs cite identical iOS/Android behavior |
| Test gates | sub-06 | Cutover requires green tests |

| Blocks | Reason |
|--------|--------|
| (none — final phase) | — |

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-30 | P7 completed: `docs/alignment.md` switched to engine-first contract, example timestamp screen updated to engine reuse + row 4a/4b demo entries, superseded migration banner/header updates applied, hard-cut grep gates verified, and internal changelog note added |
