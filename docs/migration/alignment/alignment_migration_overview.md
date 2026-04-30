# Alignment Migration — Spec & Sub-Plans Overview

## Erstellte Dateien

Alle Dateien liegen unter `docs/migration/alignment/`:

| Datei | Inhalt |
|---|---|
| [alignment-public-modes-plan.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/alignment-public-modes-plan.md) | **Public Modes Plan** — Modes, Strategies A/B, AlignmentEngine API, Linker v0 schema, locked decisions |
| [alignment-asr-mediated-ts-example.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/alignment-asr-mediated-ts-example.md) | **Reference TypeScript example** for `asrMediated` (ASR-mediated) target call site |
| [accurate-vad-segmentation-high-level-plan.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/accurate-vad-segmentation-high-level-plan.md) | **Legacy** plan superseded for mapping semantics; some buffer/anchor contract notes still apply |
| [sub-01-public-api-contract.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-01-public-api-contract.md) | **Public API Contract** — `AlignmentEngine`, `createAlignment`, `engine.alignTextToAudio`, options shape, error catalog |
| [sub-02-linker-path3-core.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-02-linker-path3-core.md) | **Linker (Path 3) Core** — reusable transcript-audio linker, rich `LinkerResultV0` (link-map + confidence), R↔H DTW |
| [sub-03-accurate-asr-mediated-integration.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-03-accurate-asr-mediated-integration.md) | **asrMediated integration** — wires Linker output into per-anchor `AlignAccurateFromPcm`; ASR hypothesis contract |
| [sub-04-accurate-chunked-forced-ctc-integration.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-04-accurate-chunked-forced-ctc-integration.md) | **chunkedForcedCtc integration** — alignment-only chunked forced CTC + token cursor + window/backtrack policy |
| [sub-05-native-bridge-and-platform-parity.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-05-native-bridge-and-platform-parity.md) | **Native bridge + parity** — slice reads, NativeSherpaOnnx surface, Android/iOS parity, OOM passthrough |
| [sub-06-tests-and-quality-gates.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-06-tests-and-quality-gates.md) | **Tests & gates** — Jest unit/integration matrix without E2E; deterministic fixtures; contract tests |
| [sub-07-docs-example-and-cutover.md](file:///Volumes/SSD/dev/react-native-sherpa-onnx/docs/migration/alignment/sub-07-docs-example-and-cutover.md) | **Docs + cutover** — `docs/alignment.md` rewrite, example screen update, hard-cut removal of legacy export |

---

## Zielbild

### Modes (final)

| # | `mode` | Segmentation | CTC | Mapping | Notes |
|---|--------|--------------|-----|---------|-------|
| 1 | `proportional` | — | No | duration × text-weight | unchanged |
| 2 | `estimated` | — | No | caller `segmentSampleCounts` | unchanged |
| 3 | `accurate` | off | Yes | full-buffer CTC | row 3 (one-shot) |
| 4a | `accurate` | on | Yes | **asrMediated** — ASR-mediated linker + CTC | rich linker result |
| 4b | `accurate` | on | Yes | **chunkedForcedCtc** — chunked forced CTC + token cursor | alignment-only |
| 5 | `vad` | on | No | anchor-only timing | unchanged surface |

### Public API surface (target)

- **`createAlignment(options?) → AlignmentEngine`**
- **`engine.alignTextToAudio(textIn, audioIn, segmentOut, options)`**
- **`engine.destroy()`**
- **Removed (hard cut):** freestanding `alignTextToAudio(...)` export
- **Naming:** `modelPath: ModelPathConfig` for accurate alignment and `SegmentationPolicy` (no `alignmentModelPath`, no `vadModelId`)

### Native / JS boundaries

```
JS (TS)
  src/alignment/
    index.ts             → AlignmentEngine factory + engine methods (only)
    engine.ts            → AlignmentEngine class (new)
    alignTextToAudio.ts  → internal worker (no public export)
    types.ts             → option/result types (modelPath: ModelPathConfig)
    linker/              → Path 3 TypeScript bindings (calls native, packs LinkerResultV0)
      types.ts
      linker.ts
NativeSherpaOnnx (TurboModule Spec)
  - alignOfflineTextToAudio(...)   (existing; extended options for accurate+segmentation)
  - linkTranscriptToAudio(...)     (new; produces rich LinkerResultV0 payload)
Android (Kotlin + C++)
  android/src/main/java/com/sherpaonnx/alignment/...     (helper, parsers, error codes)
  android/src/main/cpp/alignment/sherpa_onnx_alignment_engine.cpp   (PCM slice + CTC kernel)
  android/src/main/java/com/sherpaonnx/alignment/linker/             (linker module — new)
iOS (Obj-C++ + C++)
  ios/alignment/bridge/SherpaOnnx+Alignment.mm                       (extend)
  ios/alignment/core/AlignmentBridgeUtils.{h,mm}                     (extend)
  ios/alignment/linker/                                              (linker module — new)
```

---

## Phasenübersicht

| Phase | Sub-Plan(s) | Inhalt | Abhängigkeiten | DoD |
|-------|-------------|--------|----------------|-----|
| **P1 — Public API skeleton** | sub-01 | Introduce `AlignmentEngine`/`createAlignment`; remove freestanding export; option types updated; current native call site preserved for rows 1–3 + 5 | none | All existing rows still pass via engine path; no behavior change for rows 1, 2, 3, 5; legacy export gone |
| **P2 — Linker core (Path 3)** | sub-02 | Linker module with `LinkerResultV0` + reference↔hypothesis DTW + slice assignment; native + JS plumbing; standalone tests | P1 | Linker callable from JS for given (anchors, R, H); deterministic fixtures pass; richer link map + confidence |
| **P3 — asrMediated integration** | sub-03 | Wire `mappingStrategy: 'asr_mediated'`; per-anchor CTC on slices using linker mapping units; `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` enforced | P2 | Row 4a runs end-to-end on fixtures; no monotonic weight mapping in this path; explicit failure when timestamps missing |
| **P4 — chunkedForcedCtc integration** | sub-04 | Implement `mappingStrategy: 'chunked_forced_ctc'`; cursor + window + backtrack purely inside alignment | P1 | Row 4b runs end-to-end on fixtures; no ASR dependency; deterministic per-anchor advancement |
| **P5 — Native bridge & parity** | sub-05 | Slice-based PCM reads (no full PCM in 4a/4b); Android/iOS parity; error/diagnostics surfacing; OOM passthrough | P2, P3, P4 | Both platforms produce identical-bounded outputs on shared fixtures; no full-PCM read in 4a/4b |
| **P6 — Tests & quality gates** | sub-06 | Jest matrix (unit + integration), contract tests for error codes, golden fixtures, no-E2E rule | P1–P5 | All Jest suites green; contract codes asserted; granularity rules enforced; coverage of failure modes |
| **P7 — Docs & cutover** | sub-07 | `docs/alignment.md` rewrite, example screen, hard cut release notes (intern), cleanup of legacy paragraphs | P1–P6 | Docs in sync; example uses target API; legacy doc paragraphs marked superseded; release-ready |

> Sequencing rule: P3 and P4 can run in parallel after P2 (P3) / P1 (P4). P5 finalizes once both are integrated. P6 starts incrementally during P1–P5 with full closure last.

---

## Definition of Done — Cross-cutting

A phase is "Completed" when **all** of:

- All planned files in scope updated/created.
- All listed Jest tests added and green.
- Public API matches `alignment-public-modes-plan.md` and the relevant sub-plan exactly (no silent extras).
- No silent fallbacks introduced; every failure path has an explicit error code or warning code.
- iOS and Android behavior parity verified on shared fixtures (within documented tolerance).
- Documentation cross-links updated.
- This overview's "Fortschritts-Tracking" table flipped to `Completed` with date.

---

## Risiko- und Rollback-Strategie (technisch)

- **Hard cut:** kein Compatibility-Pfad. Rollback heißt: PR revert.
- **Rollback granularity:** PR-Granularität, **nicht** Feature-Flag. Flags sind nicht erwünscht (Plan: locked decisions).
- **OOM:** keine Guardrails. Wenn onnxruntime/sherpa-onnx OOM signalisiert, propagiert die JS-API die Fehlermeldung (`OFFLINE_OOM` oder mapped equivalent).
- **Cross-platform divergence:** Behoben durch geteilte Fixtures (sub-06) und parity tests (sub-05).
- **STT Timestamps fehlen:** kein Fallback. Hartes Fail mit `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`. Caller migriert STT-Konfig.

---

## Teststrategie (ohne E2E)

- **Unit (Jest):**
  - Option parsing pro Mode (incl. negative cases).
  - Granularity rule enforcement.
  - Error code emission (contract tests).
- **Integration (Jest mit native mocks):**
  - End-to-end JS path through engine for rows 1–5 incl. 4a/4b.
  - Linker output shape stability (snapshot of `LinkerResultV0`).
  - Per-anchor CTC slice plumbing (mocks return deterministic outputs).
- **Native parity:**
  - Same JSON fixtures consumed by Kotlin and Obj-C++ unit tests where feasible.
  - Tolerances documented per metric.
- **Explicitly out of scope:**
  - Full E2E with real models on devices.
  - On-device benchmarking SLOs.

---

## Dokumentations-Update-Plan

- `docs/alignment.md`: rewritten in P7 to match `AlignmentEngine` + ModelPathConfig + locked decisions.
- `docs/migration/alignment/alignment-public-modes-plan.md`: continuously kept as source of truth for product surface.
- `docs/migration/alignment/alignment-asr-mediated-ts-example.md`: align with final field names once implemented.
- `accurate-vad-segmentation-high-level-plan.md`: marked superseded for mapping semantics; remaining buffer/anchor contract bits cross-link to new sub-plans.

---

## Fortschritts-Tracking

| Phase | Status | Owner | Notes |
|-------|--------|-------|-------|
| P1 — Public API skeleton (sub-01) | Completed (2026-04-30) | — | AlignmentEngine API + hard-cut of freestanding export + P1 Jest coverage |
| P2 — Linker core (sub-02) | Completed (2026-04-30) | — | Internal linker core + deterministic Jest coverage + engine preflight consumption for ASR-mediated path |
| P3 — asrMediated integration (sub-03) | Completed (2026-04-30) | — | `accurate+auto+asr_mediated` now runs linker-driven per-anchor accurate slices with warning/error contracts + asrMediated Jest suite |
| P4 — chunkedForcedCtc integration (sub-04) | Completed (2026-04-30) | — | `accurate+auto+chunked_forced_ctc` now runs cursor-driven per-anchor forced CTC with deterministic advancement + chunkedForcedCtc Jest suite |
| P5 — Native bridge & parity (sub-05) | Completed (2026-04-30) | — | Descriptor-based accurate/forced-CTC bridge path on Android+iOS, native error mapping parity, and P5 Jest bridge tests |
| P6 — Tests & quality gates (sub-06) | Completed (2026-04-30) | 27 suites, 55 tests, 2 snapshots, 0 failures | All error codes cataloged; public surface locked; legacy import grep gate green |
| P7 — Docs & cutover (sub-07) | Completed (2026-04-30) | — | Engine-first docs rewrite, example screen switched to engine-only usage with row 4a/4b entries, superseded banners/headers synced, and hard-cut grep checks verified |

> Update this table as phases progress. Use `Planned` / `In Progress` / `Completed (YYYY-MM-DD)`.

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-30 | Initial overview + sub-plan layout for alignment migration; locked decisions inherited from `alignment-public-modes-plan.md` |
| 2026-04-30 | P1 completed: public AlignmentEngine skeleton shipped, freestanding `alignTextToAudio` export removed, and P1 tests added |
| 2026-04-30 | P2 completed: linker core (`types/normalize/dtw/anchorMap/confidence/linker`) implemented, Jest linker suite added, and progress table updated |
| 2026-04-30 | P3 completed: asrMediated integration wired (`runAccurateAsrMediated`), row 4a engine path enabled, and asrMediated tests added |
| 2026-04-30 | P4 completed: chunkedForcedCtc integration wired (`runAccurateChunkedForcedCtc`), forced-CTC native bridge entry added on Android/iOS, and chunkedForcedCtc tests added |
| 2026-04-30 | P5 completed: native bridge switched to PCM slice descriptors for rows 4a/4b, error mapping parity aligned across Android/iOS, and P5 native bridge Jest tests added |
| 2026-04-30 | P7 completed: docs + example cutover finalized (`docs/alignment.md` engine-first rewrite, example timestamp screen row 4a/4b demo entries), superseded-plan headers updated, and hard-cut verification checks green |
