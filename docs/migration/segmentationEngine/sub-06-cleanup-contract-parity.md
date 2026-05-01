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
6. **CI: Jest (GitHub Actions)** — siehe Workstream 6 unten.
7. **Documentation closure** (status updates and explicit deviations where intentionally kept).

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

**Tracking (Findings & Entscheidungen):** [sub-06-02-event-contract-parity-tracking.md](./sub-06-02-event-contract-parity-tracking.md)

Track and resolve planned deferrals, including:
- optional sync-JSI host API fast path for `setPartial` / `appendPartial` (while keeping TurboModule parity) — **Detailkandidaten und Ist-Stand: Workstream 2b** unten
- event-contract / Wire-Themen (**EC-01ff.**) — im Tracking-Dokument abgearbeitet; **kein** Ersatz für 2b
- any remaining unified-read edge cases (live/offline parity)

### 2b) JSI-Fast-Path Candidates (general)

Evaluate high-frequency APIs for potential migration from Promise-based TurboModule calls
to synchronous JSI host calls (where beneficial and safe).

#### Ist-Stand (Re-Audit, Code — keine Text/Segment-JSI)

Synchrones JSI ist **bereits** nur für **Offline-/Live-Audio-Samples** angebunden (PCM / `ArrayBuffer`), **nicht** für Live-Text oder Segmentbuffer:

| Ebene | Referenz |
|-------|----------|
| TS-Oberfläche | `src/audiobuffer/jsi.ts` — `getOfflineBufferSamples`, `createOfflineFromSamples`, `getLiveBufferSamples`, `appendSamplesToLive`; Installation über `installJSI()` → `global.__SherpaOnnxJSI` |
| iOS | `ios/audiobuffer/SherpaOnnxJSI.cpp` / `SherpaOnnx+JSI.mm` (`installJSIBindings`) |
| Android | `android/src/main/cpp/jni/audiobuffer/SherpaOnnxJSI.cpp` (+ Install-Bridge) |
| Verhalten | `docs/internal/liveaudiobuffer-internal.md` (JSI-Fast-Path für Append/Slice) |

**Folgerung:** Die frühere 2b-Kandidatenliste (Text/Segment) ist **weiterhin vollständig offen** — es sind **keine** neuen Implementierungen für `setPartial` / `getSegments` / … als JSI hinzugekommen; Audio-JSI war schon vorher da und ist **kein** 2b-Kandidat, sondern **bereits umgesetzter** Hot-Path (Abgrenzung unten).

#### Priorisierte Kandidaten (2b) — Status: alles „offen“ (TurboModule / async)

| Prio | Öffentliche / wirksame TS-API | Wesentliche TurboModule-/Spec-Methoden (`NativeSherpaOnnx`) | Bemerkung |
|------|------------------------------|-------------------------------------------------------------|-----------|
| **P0** | `setPartial()` | `setLiveTextBufferPartial` | Hot write — klassischer 2b-Anker |
| **P0** | `appendPartial()` | `appendLiveTextBufferPartial` | Hot write |
| **P0** | `commitSegment()` | **Orchestrierung:** u. a. `getLiveTextBufferPartialSlice`, `appendLiveTextSegment`, `setLiveTextBufferPartial`, `getPipelineAudioBufferInfo`, `appendLiveSegment`, `getLiveSegmentBufferSegmentCount`, `annotateSpeechSegment` (indirekt), … | Kein einzelner Native-Call — JSI-Evaluierung ggf. **pro Teilschritt** oder gebündelte Host-API |
| **P1** | `getSegments()` | Über `src/segment/index.ts`: u. a. `getLiveTextBufferSegments`, `getOfflineTextBuffer…`, `getLiveSegmentBufferSegments`, `getPipelineSegmentBufferInfo`, … je nach Domain | Öffentliche API komponiert mehrere Reads |
| **P1** | `getSegmentCount()` | u. a. `getLiveTextBufferSegmentCount`, Offline-Zähler-Pfade, `getLiveSegmentBufferSegmentCount`, `getPipelineSegmentBufferInfo` | Wie P1 |
| **P2** | `getLiveTextBufferPartialSlice()` (exportiert in `textbuffer` + genutzt in `commitSegment`) | `getLiveTextBufferPartialSlice` | Hohe Frequenz in UI/Debug und im Commit-Pfad |
| **P2** | Segment-/Count-Reads in Poll-Loops | dieselben Native-Methoden wie P1, ggf. offline: `getOfflineTextBuffer…` / Segment-Buffer-Reads | Wie ursprünglich „helper reads“ |

#### Gegenüber früherer Liste — ergänzt / präzisiert

- **`appendLiveTextSegment`** explizit: zentral für Text-`commitSegment` und Engine-Pfade; gehorte nicht in der Kurzliste, ist aber ein natürlicher **P0/P1-Grenzfall** beim Bündeln von Schreib-/Commit-Operationen.
- **Unterliegende Segment-Lese-APIs** (`getLiveTextBufferSegments`, `getLiveTextBufferSegmentCount`, `getLiveSegmentBufferSegments`, `getLiveSegmentBufferSegmentCount`, `getPipelineSegmentBufferInfo`, …) als messbare Einheiten nennen — `getSegments`/`getSegmentCount` sind nur die TS-Fassade.

#### Abgrenzung

- **Bereits JSI (nicht 2b-Aufgabe):** Live-/Offline-Audio Sample-Transport (`audiobuffer/jsi.ts`) — keine Doppel-Migration.
- **Workstream 2 (EC-01ff.):** Event-Contract / Wire / Public Callbacks — **abgeschlossen** laut [sub-06-02-event-contract-parity-tracking.md](./sub-06-02-event-contract-parity-tracking.md); **ersetzt 2b nicht**.

#### Decision policy per candidate

1. Measure baseline (latency/jitter/calls-per-second) on Android + iOS.
2. Migrate to sync-JSI only when measurable benefit exists or when contract hardening requires single-path execution.
3. After migration, remove legacy async path where clean-cut is desired and parity is verified.

### 3) Legacy & Dead Code Removal

**Ist-Audit (Befunde, Cold-Cut-kompatible Kandidaten):** [sub-06-03-legacy-dead-code-audit.md](./sub-06-03-legacy-dead-code-audit.md) (TS/README) · **Native Android/iOS (Legacy-Kommentare / Stichprobe):** [sub-06-04-native-android-ios-legacy-audit.md](./sub-06-04-native-android-ios-legacy-audit.md)

- remove obsolete segment/metadata models replaced by canonical `Segment`/`SegmentLink`
- remove old adapters and fallback code paths no longer reachable
- collapse duplicated conversion/validation paths where canonical layer already exists

### 4) Test Completion

**Ist-Abgleich (Jest vs. Minimum-Liste):** [sub-06-05-workstream-4-test-coverage-matrix.md](./sub-06-05-workstream-4-test-coverage-matrix.md)

Minimum required coverage additions:
- `setPartial`/`appendPartial` behavior
- `commitSegment` for text + audio (manual + edge cases)
- finalize flush behavior
- `getSegmentBuffer`/`getSegments`/`getSegmentCount` live/offline parity
- `SegmentLinkMap` CRUD + duplicate rejection + query semantics + lifecycle
- cross-platform behavior parity checks (Android/iOS)

### 5) Segmentation Mode Harmonization (Cross-Feature, incl. Alignment)

Goal: remove semantic drift for `segmentation.mode` across all migrated features and align runtime behavior with the segmentation architecture.

Target semantics:
- `mode: 'off'` = no segmentation engine-driven segmentation.
- `mode: 'manual'` = caller/manual commit driven flow (streaming-focused); must not silently behave like `auto`.
- `mode: 'auto'` = SegmentationEngine-driven segmentation with policy.
- `segmentation.policy` is valid only for `mode: 'auto'`; invalid combinations must fail with `SEGMENTATION_POLICY_INVALID` (shared code across features).

Scope (Phase 7):
- STT, TTS, Punctuation, Enhancement, Alignment.
- Type-level + runtime-level behavior parity (no "manual in types but auto in runtime" drift).
- Error-code/message consistency for invalid mode/policy combinations.

Minimum test matrix (per feature):
- `mode='off'`: verify non-segmented path and expected output semantics.
- `mode='manual'`:
  - where supported: verify manual-commit path, no implicit engine attach.
  - where not supported: verify explicit rejection (`SEGMENTATION_POLICY_INVALID`), no fallback.
- `mode='auto'`: verify attach/orchestrated segmentation path with valid policy.
- `policy` with `mode='off'|'manual'`: verify explicit reject (`SEGMENTATION_POLICY_INVALID`).
- invalid `auto` policy shape/evaluator: verify explicit reject (`SEGMENTATION_POLICY_INVALID`).
- parity checks:
  - identical contract behavior on Android/iOS.
  - consistent behavior across offline/streaming APIs where both are exposed.
- Alignment-specific:
  - validate chosen `manual` strategy (supported or rejected) is explicit and tested in both fake-live ingestion and link creation paths.

### 6) GitHub Actions: Jest-Workflow (CI)

Ziel: Die Jest-Test-Suite des Pakets (`yarn test` / `jest`) läuft zuverlässig in CI auf jedem relevanten PR und auf `main`, damit Regressions früh auffallen.

Vorgehen (Phase 7):

1. **Workflow anlegen oder prüfen**  
   - Falls noch nicht vorhanden: unter `.github/workflows/` einen Workflow hinzufügen, der:
     - Node gemäß `.nvmrc` / Repository-Standard nutzt,
     - `yarn install` (bzw. `yarn install --immutable` für Yarn Berry),
     - **`yarn test --ci`** (Jest) ausführt.  
   - Im Repo existiert bereits ein Referenz-Workflow: [`.github/workflows/test-js.yml`](../../../.github/workflows/test-js.yml) (`name: Test - JS`, Schritt *Run JS tests* → `yarn test --ci`). Phase 7 soll diesen **verifizieren** (Trigger, Pfade, Node/Yarn) und bei Lücken **anpassen oder erweitern** (z. B. `yarn typecheck` in derselben oder separater Job-Kette, falls gewünscht).

2. **Abdeckung**  
   - `on:` so wählen, dass SDK-Änderungen an `src/**` und Tests zuverlässig laufen (kein zu aggressives `paths-ignore` für produktiven Code).  
   - Optional: separater Job nur für schnelle Unit-Tests vs. längere Integrationstests — nur falls nötig.

3. **Definition in DoD**  
   - Grüner Jest-Run in CI ist Voraussetzung für „Phase 7 / Sub-06 abgeschlossen“; bei rotem Workflow ist kein „release-ready“-Status.

---

## Deliverables

1. **Phase-7 Audit Matrix** (requirement-by-requirement status with code refs).
2. **Parity Patchset** (all must-fix issues resolved).
3. **Cleanup Patchset** (dead/legacy code removed).
4. **JSI Candidate Evaluation Sheet** (candidate, priority, measured baseline, decision, follow-up).
5. **Test Report** (new tests + executed verification commands).
6. **Jest-CI** — funktionierender GitHub Actions Workflow (siehe Workstream 6); mindestens `yarn test --ci` grün auf `main`/PR; Verweis auf die Workflow-Datei im Abschlussbericht.
7. **Updated statuses** in overview and all touched sub-plans.

---

## Definition of Done

- No unresolved `must-fix-before-release` items remain.
- Remaining deviations (if any) are documented and explicitly accepted.
- Android/iOS parity for public contracts is verified.
- Critical segment/link APIs have automated tests covering happy path + edge cases.
- Migration docs and real implementation are aligned.
- Jest läuft in GitHub Actions wie in Workstream 6 beschrieben (bestehenden Workflow pflegen oder neuen anlegen).

