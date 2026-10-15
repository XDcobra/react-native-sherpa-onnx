# Phase 5 — DocTR documentation parity + test coverage gaps

> **Status**: Plan (do not implement from this file)
> **Branch**: `feat/add-ocr-doctr`
> **Depends on**: Phases 1–4 (packs published, DoctrBackend, TS API, detect, download, `ocr.doctr` catalog, host tests, Jest tests)
> **Explicitly out of scope**: Example App, VoiceLab consumer changes

---

## 1 · Documentation audit — every file that mentions OCR / ppocr

### 1A · `docs/ocr-offline.md` — **major edits**

This is the primary OCR user guide. It currently contains **28 occurrences of "ppocr"** and **0 of "doctr"**. Nearly every section needs updating.

| Line(s) | Current content | Required edit |
|---------|----------------|---------------|
| L8 | `Family: **ppocr** (PP-OCR …). modelType: 'auto' \| 'ppocr'.` | Rewrite: "Families: **ppocr** (PP-OCR Det/Rec/optional Cls) and **doctr** (OnnxTR Det/Rec/manifest). `modelType: 'auto' \| 'ppocr' \| 'doctr'`." |
| L4 (module docstring echoed) | Module-level text says "v1 backend: ppocr" | Update to "v1+v2 backends: ppocr + doctr" or remove version numbering |
| L20–24 (Quick start imports) | `isOcrPpocrDetectSuccess` only | Add parallel doctr snippet or a note: "For doctr packs, use `isOcrDoctrDetectSuccess`" |
| L40 | `ppocrv6-tiny` hardcoded model dir | Add a doctr example below (e.g. `doctr-mobile`) |
| L43–45 (detect guard) | `if (!isOcrPpocrDetectSuccess(det))` | Show both guards or generalize to `result.success` with a note about narrow typing |
| L126–140 (Models table) | Only `ppocr` row; "auto → only known families" | Add `doctr` row: `Det ONNX + Rec ONNX + ocr_manifest.json (paths.manifest)` — no cls, no rec_dict |
| L128 | Canonical names: `det.onnx, rec.onnx, rec_inference.yml, optional cls.onnx` | Add doctr canonical names: `det.onnx, rec.onnx, ocr_manifest.json` |
| L132–140 (Official packs table) | ppocr packs only | Add rows for `doctr-mobile.tar.bz2` (tiny/small, `en,fr`) and `doctr-default.tar.bz2` (medium, 15 Latin European langs) |
| L141 | `getPpocrLanguages()` link only | Add mention of `iso6391HintsForOcrModelType('doctr')` and `DOCTR_ISO6391_HINTS` |
| L147–150 (ensureModel + detect snippet) | ppocr only | Add parallel doctr code example |
| L177 (detectOcrModel description) | `isOcrPpocrDetectSuccess(pre)` narrows … | Add: "For doctr, `isOcrDoctrDetectSuccess(pre)` narrows paths to `{ det, rec, manifest }`" |
| L180–190 (createOCR) | `ppocr: { maxSideLen … }` only | Add `doctr: { detBoxThresh, detBoxScoreThresh, detUnclipRatio }` option docs |
| L288–290 (Types table) | `OcrModelType = 'auto' \| 'ppocr'` | Update to `'auto' \| 'ppocr' \| 'doctr'` |
| L290 | `OcrConcreteModelType = 'ppocr'` | Update to `'ppocr' \| 'doctr'` |
| L291 | `OcrFamily = 'ppocr'` | Update to `'ppocr' \| 'doctr'` |
| L294 | `OcrInitializeOptions` — `ppocr?` only | Add `doctr?` field |
| L295 | `OcrPpocrOptions` | Add row for `OcrDoctrOptions` (`detBoxThresh`, `detBoxScoreThresh`, `detUnclipRatio`) |
| L300 | `OcrPpocrSuccessPaths` only | Add row for `OcrDoctrSuccessPaths` (`{ det, rec, manifest }`) |
| L300 (table) | Missing `isOcrDoctrDetectSuccess` | Add row |
| L404 | See also: `getPpocrLanguages` only | Add `iso6391HintsForOcrModelType('doctr')` |

**Approach**: Restructure the Models and Types sections to present both families side-by-side rather than duplicating the entire doc. Use a "per-family" sub-heading or tabular format.

### 1B · `docs/model-languages.md` — **minor edits**

| Line(s) | Current content | Required edit |
|---------|----------------|---------------|
| L84 | Language tables table: only `getPpocrLanguages()` row for OCR | Add row: "`getDoctrLanguages()` if one is created, or note that doctr uses `iso6391HintsForOcrModelType('doctr')` + `DOCTR_ISO6391_HINTS`" |
| L88–89 | `iso6391HintsForOcrModelType(…)` doc — mentions "pack-first from sources.csv, family fallback ppocr" | Update description to: "…family fallback `ppocr` or `doctr`" |
| L93 | Constants list: `PPOCR_LANGUAGES, …` | Add `DOCTR_ISO6391_HINTS` to the list |
| L157–160 | TTS/alignment/OCR hint helpers — shows `getPpocrLanguages()` only | Add `DOCTR_ISO6391_HINTS` usage example, e.g. `iso6391HintsForOcrModelType('doctr', 'doctr-mobile')` |
| L163 | OCR hint description | Append: "DocTR: `iso6391HintsForOcrModelType('doctr')` returns the family list; per-pack CSV narrows it (e.g. `doctr-mobile` → `['en','fr']`)" |
| L188 | See also: `getPpocrLanguages` | Add doctr cross-ref |

**Decision point**: Do we add a `getDoctrLanguages()` picker getter (parallel to `getPpocrLanguages()`) or is `DOCTR_ISO6391_HINTS` + `iso6391HintsForOcrModelType` sufficient? Recommendation: **yes, add `getDoctrLanguages()`** for symmetry — it returns `ModelLanguage[]` from `DOCTR_ISO6391_HINTS` mapped to `{ id, name }`. Generated from `catalog/model-language-catalog.json` the same way as ppocr.

### 1C · `docs/feature-pipelines.md` — **minimal edits**

| Line(s) | Current content | Required edit |
|---------|----------------|---------------|
| L232–249 (OCR offline patterns section) | Flowchart + "Related docs" — no mention of doctr | Add a note: "Both `ppocr` and `doctr` families use the same `createOCR` → `recognize` pipeline; `modelType: 'auto'` resolves from pack layout." |
| Related docs bullets | `ocr-offline.md` only | Fine as-is (ocr-offline.md will cover both) |

### 1D · `docs/README.md` — **one-line edit**

| Line | Current content | Required edit |
|------|----------------|---------------|
| L113 | `[ocr-offline.md](./ocr-offline.md) … family ppocr` | Update description to: "family `ppocr` · `doctr`" |

### 1E · `README.md` (root) — **one-line edit**

| Line | Current content | Required edit |
|------|----------------|---------------|
| L80 | `✅ Offline OCR: [Offline](./docs/ocr-offline.md)` | Consider appending: "(PP-OCR + DocTR)" or leave as-is (families are an implementation detail for the root readme). Recommendation: leave as-is. |

### 1F · `scripts/ocr-models/README.md` — **already done ✓**

This file already documents both `ppocr` and `doctr` archive layouts, the CSV format with `family` column, `doctr-mobile`/`doctr-default` pack descriptions, and the `ocr_manifest.json` discriminator. **No further edits needed.**

### 1G · `docs/imagebuffer-offline.md` / `docs/textbuffer-offline.md` — **no edits needed**

These docs reference "OCR" generically (not family-specific). Cross-refs point to `ocr-offline.md`. No ppocr-specific content. ✓

### 1H · `THIRD_PARTY_LICENSES/README.md` — **no edits needed**

Contains no OCR-specific content. License CSVs at `android/…/ocr-models-license-status.csv` and `ios/…/ocr-models-license-status.csv` are synced by the publish workflow and already include doctr rows. ✓

---

## 2 · Test coverage audit — gaps vs ppocr

### 2A · Host C++ tests (`test/cpp/ocr/`)

| Test file | ppocr coverage | doctr coverage | Gap |
|-----------|---------------|----------------|-----|
| `ppocr_host_test.cpp` | ✅ Factory (ppocr, auto), CTC unit, DB unit, golden (en/de/zh) | N/A | — |
| `doctr_host_test.cpp` | N/A | ✅ Factory (doctr), manifest parse, CTC blank-last, PARSeq decode, DB sigmoid, UTF-16 length, golden (en/de) | **Gap: `zh_nihao` golden not parameterized** |

**Gap 2A-1**: doctr golden test only covers `en_hello` and `de_guten_tag`. The ppocr test also covers `zh_nihao`. Doctr-mobile is Latin-only (`en,fr`), so Chinese is **expected to fail or produce garbage**. Two options:
- (a) Add `zh_nihao` with a weaker assertion (non-empty text + at least 1 span, no exact match) — demonstrates the pipeline doesn't crash on CJK input.
- (b) Skip `zh_nihao` for doctr with a comment explaining the limitation.
- **Recommendation**: option (a) — add as a "smoke" golden (non-empty text, ≥1 span, no text match).

### 2B · Host C++ test — model_detect for doctr

| Test area | Coverage | Gap |
|-----------|---------|-----|
| `model_detect_test.cpp` | ✅ doctr detect with manifest, doctr missing manifest, doctr auto-resolve from `doctr-mobile` name | None |
| `curated_language_catalog_test.cpp` | ✅ `OcrRowsForModelType("doctr")`, `OcrPackRowsForModelKey("doctr-mobile")`, `OcrPackRowsForModelKey("doctr-default")` | None |

### 2C · CI workflow for doctr host tests

| Workflow | ppocr | doctr | Gap |
|----------|-------|-------|-----|
| `.github/workflows/test-ocr-host.yml` | ✅ Downloads `ppocrv6-tiny`, builds `ppocr_host_test`, runs | ❌ Does NOT build or run `doctr_host_test` | **Gap 2C-1** |

**Gap 2C-1**: The CI workflow needs a parallel job (or steps in the same job) that:
1. Downloads + caches `doctr-mobile.tar.bz2` from `ocr-models` release
2. Extracts to `build/ocr-models/doctr-mobile`
3. Builds `doctr_host_test`
4. Runs `ctest -R doctr_host_test` with `DOCTR_MODEL_DIR` env var

Also update the workflow comment header from "real PpocrBackend golden with ppocrv6-tiny" to include doctr.

### 2D · Jest tests (`src/ocr/__tests__/offline-api.test.ts`)

| Test case | ppocr | doctr | Gap |
|-----------|-------|-------|-----|
| `createOCR` + `recognize` + operationId | ✅ | — | **Gap 2D-1**: No `createOCR` test with `modelType: 'doctr'` that calls `recognize` |
| `onProgress` filtering | ✅ | — | Shared code path — no separate doctr test needed |
| `AbortSignal` cancel | ✅ | — | Shared code path — no separate doctr test needed |
| `detectOcrModel` ppocr success + paths | ✅ | — | — |
| `detectOcrModel` ppocr fails on missing paths | ✅ | — | — |
| `createOCR` with doctr options | — | ✅ | — |
| `detectOcrModel` doctr success + manifest | — | ✅ | — |
| `isOcrDoctrDetectSuccess` narrows | — | ✅ | — |
| `isOcrDoctrDetectSuccess` rejects ppocr | — | ✅ | — |
| `detectOcrModel` doctr fails missing manifest | — | ✅ | — |
| `isOcrModelType` + `OCR_MODEL_TYPES` | ✅ (includes doctr) | ✅ | — |
| **`createOCR` doctr + `recognize` round trip** | — | ❌ | **Gap 2D-1** |
| **`destroy` then `recognize` throws doctr** | — | ❌ | **Gap 2D-2** (also missing for ppocr but tests it implicitly) |

**Gap 2D-1**: Add a test that creates a doctr OCR engine, calls recognize, verifies native bridge call includes doctr-specific bridge options, and calls destroy.

**Gap 2D-2** (nice-to-have): Explicitly test that `recognize` after `destroy` throws `OCR_INSTANCE_NOT_FOUND` (currently only implicitly covered).

### 2E · Jest tests (`src/model-languages/ocr/__tests__/hints.test.ts`)

| Test case | ppocr | doctr | Gap |
|-----------|-------|-------|-----|
| Family getter (`getPpocrLanguages`) | ✅ | — | **Gap 2E-1**: No `getDoctrLanguages()` test (because the function doesn't exist yet) |
| `iso6391HintsForOcrModelType` family fallback | ✅ (`ppocr`) | ✅ (`doctr`) | — |
| Pack-level override | ✅ (tiny, small) | ✅ (mobile, default) | — |
| `DOCTR_ISO6391_HINTS` constant | — | ✅ | — |
| `publicLanguageHintsFromNative` OCR doctr | — | ✅ | — |

**Gap 2E-1**: If we add `getDoctrLanguages()`, add a parallel test (returns `ModelLanguage[]`, contains `en`/`fr`, length ≥ 2).

### 2F · Jest download tests

| Test file | ppocr | doctr | Gap |
|-----------|-------|-------|-----|
| `catalogHints.test.ts` | ✅ ppocr catalog hints | ✅ doctr catalog hints | — |
| `github-asset-rules.test.ts` | ✅ `ppocrv6-tiny.tar.bz2` accepted | ❌ No doctr pack test | **Gap 2F-1** |
| `builtin-github.test.ts` | — | ❌ No OCR `listModels` test for XDcobra | **Gap 2F-2** |
| `registry.test.ts` | ✅ `Ocr → github_xdcobra` default | — | — |

**Gap 2F-1**: Add `isAssetSupportedForCategory(Ocr, 'doctr-mobile.tar.bz2', 'tar.bz2')` → `true` test case to `github-asset-rules.test.ts`.

**Gap 2F-2** (nice-to-have): Add a test in `builtin-github.test.ts` that mocks XDcobra OCR release listing and verifies both ppocr and doctr packs are returned with correct `modelType`.

### 2G · Structure/fixture files

| Fixture | Status |
|---------|--------|
| `test/fixtures/ocr-models-expected.csv` | ✅ Has `doctr-default.tar.bz2,doctr` and `doctr-mobile.tar.bz2,doctr` |
| `test/fixtures/ocr-models-structure.txt` | ✅ Has full doctr-default and doctr-mobile layouts |
| `test/fixtures/ocr/` images | ✅ `en_hello.png`, `de_guten_tag.png`, `zh_nihao.png` — used by both backends |
| `test/fixtures/ocr/expected/` | ✅ Golden JSONs for all three (ppocr-derived; doctr uses weaker assertions) |
| `scripts/ci/check-model-csvs.sh` | ❌ Does **not** check `ocr-models` release (XDcobra repo, not k2-fsa) | **Gap 2G-1** |

**Gap 2G-1** (low priority): `check-model-csvs.sh` only checks k2-fsa/sherpa-onnx releases. OCR packs live on XDcobra/react-native-sherpa-onnx. Consider adding an OCR rail or leaving as-is (the publish workflow + structure fixtures provide coverage).

---

## 3 · Stale code clean-up

### 3A · Source comments

| File | Line | Current text | Fix |
|------|------|-------------|-----|
| `src/ocr/index.ts` | L4 | `* ImageBuffer → TextBuffer (+ TextSpatialSpans). v1 backend: ppocr.` | Change to `v1 backends: ppocr, doctr.` or remove version label |
| `src/ocr/types.ts` | L31 | `/** Span granularity requested at recognize time. v1 backends produce \`line\`. */` | Change to `Backends produce \`line\` spans.` (remove "v1") |

### 3B · `CanDoctrLayout` stubs

Search result: **No `CanDoctrLayout` stubs found.** ✓ (Already cleaned up or never existed in TS.)

### 3C · Other stale patterns

| Pattern searched | Result |
|-----------------|--------|
| `ppocr only` / `ppocr-only` | None found ✓ |
| `backend.*ppocr` (limiting comments) | None found ✓ |
| `TODO.*doctr` / `FIXME.*doctr` | None found ✓ |
| `TODO` / `FIXME` in `src/ocr/` | None found ✓ |

---

## 4 · File-by-file change list

### Documentation files

| # | File | Action | Effort |
|---|------|--------|--------|
| D1 | `docs/ocr-offline.md` | Major rewrite: add doctr family to every section (types, models table, packs table, examples, API ref, see-also) per §1A | High |
| D2 | `docs/model-languages.md` | Minor: add doctr entries to tables, constants list, example snippets per §1B | Low |
| D3 | `docs/feature-pipelines.md` | One note in OCR offline patterns section per §1C | Trivial |
| D4 | `docs/README.md` | Update OCR table row description per §1D | Trivial |

### Source files

| # | File | Action | Effort |
|---|------|--------|--------|
| S1 | `src/ocr/index.ts` | Fix module docstring (§3A) | Trivial |
| S2 | `src/ocr/types.ts` | Fix granularity comment (§3A) | Trivial |
| S3 | `src/model-languages/generated/catalog.ts` | Add `getDoctrLanguages()` function + `DOCTR_LANGUAGES` constant (generated; requires `catalog/model-language-catalog.json` edit + `yarn generate:model-language-catalog`) | Low |
| S4 | `src/model-languages/ocr/index.ts` | Re-export `getDoctrLanguages`, `DOCTR_LANGUAGES` | Trivial |

### Test files

| # | File | Action | Effort |
|---|------|--------|--------|
| T1 | `test/cpp/ocr/doctr_host_test.cpp` | Add `zh_nihao` to golden parameterized test (smoke — non-empty, ≥1 span) per §2A | Low |
| T2 | `.github/workflows/test-ocr-host.yml` | Add doctr job: download `doctr-mobile.tar.bz2`, cache, build `doctr_host_test`, run per §2C | Medium |
| T3 | `src/ocr/__tests__/offline-api.test.ts` | Add doctr recognize round-trip test per §2D-1 | Low |
| T4 | `src/model-languages/ocr/__tests__/hints.test.ts` | Add `getDoctrLanguages()` test per §2E-1 (contingent on S3) | Low |
| T5 | `src/download/sources/__tests__/github-asset-rules.test.ts` | Add `doctr-mobile.tar.bz2` acceptance test per §2F-1 | Trivial |

### Nice-to-have (lower priority)

| # | File | Action | Effort |
|---|------|--------|--------|
| N1 | `src/ocr/__tests__/offline-api.test.ts` | Add `destroy` → `recognize` throws test per §2D-2 | Trivial |
| N2 | `src/download/sources/__tests__/builtin-github.test.ts` | Add XDcobra OCR listModels mock test per §2F-2 | Medium |

---

## 5 · Acceptance checklist

### Documentation parity

- [ ] `docs/ocr-offline.md` mentions **both** `ppocr` and `doctr` in: family line, model type union, models table, packs table, quick-start example, detect example, createOCR example, types table, see-also links
- [ ] `docs/model-languages.md` lists `DOCTR_ISO6391_HINTS`, `getDoctrLanguages()`, and example usage for `iso6391HintsForOcrModelType('doctr', …)`
- [ ] `docs/feature-pipelines.md` OCR section notes both families
- [ ] `docs/README.md` OCR row mentions both families

### Test coverage

- [ ] `doctr_host_test` golden covers `en_hello`, `de_guten_tag`, and `zh_nihao` (smoke)
- [ ] CI workflow `test-ocr-host.yml` builds and runs **both** `ppocr_host_test` and `doctr_host_test`
- [ ] Jest `offline-api.test.ts` has a doctr `createOCR` + `recognize` round-trip test
- [ ] Jest `hints.test.ts` has `getDoctrLanguages()` test (if function is added)
- [ ] Jest `github-asset-rules.test.ts` accepts `doctr-mobile.tar.bz2` for `ModelCategory.Ocr`

### Stale code

- [ ] `src/ocr/index.ts` L4 no longer says "v1 backend: ppocr"
- [ ] `src/ocr/types.ts` L31 no longer says "v1 backends"
- [ ] No `CanDoctrLayout` stubs remain (already clean)
- [ ] `yarn generate:model-language-catalog` runs clean, `yarn check:model-language-catalog` passes

### Final parity audit

- [ ] `rg -i 'ppocr' docs/ocr-offline.md` — every ppocr mention has a parallel doctr mention or is generalized
- [ ] `rg -i 'getPpocrLanguages' docs/` — matched by doctr getter in same files
- [ ] All `isOcrPpocrDetectSuccess` doc/test appearances have parallel `isOcrDoctrDetectSuccess` coverage
- [ ] `yarn test` passes (Jest suite)
- [ ] Host tests pass locally: `ctest -R ppocr_host_test` and `ctest -R doctr_host_test`

---

## 6 · What NOT to do

1. **No Example App changes** — example app screens, navigation, or showcase code are explicitly out of scope.
2. **No VoiceLab consumer changes** — no edits to `voicelab-app` or its feature orchestration.
3. **No new native code** — Phase 5 is docs + tests only; DoctrBackend, factory, bridge are complete from Phase 4.
4. **No API surface changes** (beyond optional `getDoctrLanguages()` convenience getter) — the TS types, bridge, and native API are frozen.
5. **No model re-publishing** — packs are already on the `ocr-models` release tag; do not re-run `build_and_upload.js`.
6. **No refactoring** of existing ppocr paths — minimal targeted edits only.
7. **No iOS-specific work** — host tests run on Linux/macOS CI; no Xcode project changes.
