# Sub-Plan 06: Cleanup & Contract Parity

## Status
- Draft
- Depends on: Sub-Plan 01, 02, 03, 04, 05
- Planned execution phase: Phase 7

## Purpose

Final hardening pass before release:

1. Verify each implemented contract against the migration docs (overview + all sub-plans).
2. Close remaining implementation gaps that were intentionally deferred.
3. Remove dead code, legacy compatibility leftovers, and inconsistent paths discovered during migration.
4. Produce a clear release-readiness report with explicit residual risk.

---

## Scope

1. **Contract parity audit** (Doc vs. Code) for Sub-Plan 01–05.
2. **Deferred implementation items** (example: optional sync-JSI host fast path for `setPartial` / `appendPartial`).
3. **Cross-platform parity** (Android/iOS behavior and error-code consistency).
4. **Legacy cleanup** (stale segment models, old adapters, no-longer-used helpers).
5. **Test hardening** (missing coverage in critical segment/link/runtime paths).
6. **Documentation closure** (status updates and explicit deviations where intentionally kept).

---

## Inputs (Authoritative Sources)

- `segmentation_engine_overview.md`
- `sub-01-segment-contract.md`
- `sub-02-segmentation-engine-core.md`
- `sub-03-buffer-integration.md`
- `sub-04-transfer-offline-orchestration.md`
- `sub-05-feature-pipeline-migration.md`

---

## Workstreams

### 1) Contract-by-Contract Audit

For each sub-plan requirement:
- mark **Implemented**, **Partially implemented**, or **Missing**
- attach concrete code reference(s)
- define fix owner + fix location
- classify as:
  - `must-fix-before-release`
  - `acceptable-deviation` (requires explicit rationale in docs)

### 2) Deferred Parity Items

Track and resolve planned deferrals, including:
- optional sync-JSI host API fast path for `setPartial` / `appendPartial` (while keeping TurboModule parity)
- any remaining event-contract mismatch (`onSegment`, finalize semantics, payload shape)
- any remaining unified-read edge cases (live/offline parity)

### 2b) JSI-Fast-Path Candidates (general)

Evaluate high-frequency APIs for potential migration from Promise-based TurboModule calls
to synchronous JSI host calls (where beneficial and safe).

Prioritized candidate classes:

- **P0 (hot write path):**
  - `setPartial()`
  - `appendPartial()`
  - `commitSegment()`
- **P1 (authoritative read path):**
  - `getSegments()`
  - `getSegmentCount()`
- **P2 (high-frequency helper reads):**
  - `getLiveTextBufferPartialSlice()`
  - segment-buffer read/count helpers used in polling loops

Decision policy per candidate:

1. Measure baseline (latency/jitter/calls-per-second) on Android + iOS.
2. Migrate to sync-JSI only when measurable benefit exists or when contract hardening requires single-path execution.
3. After migration, remove legacy async path where clean-cut is desired and parity is verified.

### 3) Legacy & Dead Code Removal

- remove obsolete segment/metadata models replaced by canonical `Segment`/`SegmentLink`
- remove old adapters and fallback code paths no longer reachable
- collapse duplicated conversion/validation paths where canonical layer already exists

### 4) Test Completion

Minimum required coverage additions:
- `setPartial`/`appendPartial` behavior
- `commitSegment` for text + audio (manual + edge cases)
- finalize flush behavior
- `getSegmentBuffer`/`getSegments`/`getSegmentCount` live/offline parity
- `SegmentLinkMap` CRUD + duplicate rejection + query semantics + lifecycle
- cross-platform behavior parity checks (Android/iOS)

---

## Deliverables

1. **Phase-7 Audit Matrix** (requirement-by-requirement status with code refs).
2. **Parity Patchset** (all must-fix issues resolved).
3. **Cleanup Patchset** (dead/legacy code removed).
4. **JSI Candidate Evaluation Sheet** (candidate, priority, measured baseline, decision, follow-up).
5. **Test Report** (new tests + executed verification commands).
6. **Updated statuses** in overview and all touched sub-plans.

---

## Definition of Done

- No unresolved `must-fix-before-release` items remain.
- Remaining deviations (if any) are documented and explicitly accepted.
- Android/iOS parity for public contracts is verified.
- Critical segment/link APIs have automated tests covering happy path + edge cases.
- Migration docs and real implementation are aligned.

