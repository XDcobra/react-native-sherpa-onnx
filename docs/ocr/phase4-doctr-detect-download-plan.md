# Phase 4 — DocTR Detect / Download / Language Catalog

> Branch: `feat/add-ocr-doctr`
> Prereqs: Phase 1 (packs published) ✅ • Phase 2 (DoctrBackend C++) ✅ • Phase 3 (TS API + bridges) ✅

---

## 0  Executive Summary

Phase 3 delivered the **full TS + native bridge** integration for doctr. Phase 4 completes the
**catalog, download, and language-hint pipeline** so that doctr packs (`doctr-mobile`, `doctr-default`)
are discoverable, downloadable, and annotated with languages exactly like ppocr packs already are.

The delta is **smaller than expected** — most of the work was already done in Phases 1–3:

| Area | Current State | Phase 4 Work |
|------|--------------|--------------|
| C++ detect (`kDoctr`, `CanDoctrLayout`, `kDoctrReqs`) | ✅ Complete | None |
| Unified detect (`DetectModelInternal → OCR`) | ✅ doctr recognized | None |
| Path fill (`OcrModelPathsToStringMap`) | ✅ includes `manifest` | None |
| Validate (`ParseOcrModelTypeLocal`, `kDoctrReqs`) | ✅ doctr aliases | None |
| TS types + bridges | ✅ Complete | None |
| Packs published on `ocr-models` tag | ✅ `doctr-mobile.tar.bz2`, `doctr-default.tar.bz2` | None |
| Fixtures (`ocr-models-structure.txt`, `ocr-models-expected.csv`) | ✅ doctr entries present | None |
| Download: `ModelCategory.Ocr`, `ocr-models` tag | ✅ Registered | None |
| `sources.csv` | ✅ doctr rows present | None |
| Generated pack maps (`OCR_PACK_ISO6391_HINTS_BY_ID/STEM`) | ✅ doctr entries present | None |
| C++ pack rows (`OcrPackRowsForModelKey`) | ✅ doctr entries present | None |
| **catalog.json `ocr.doctr` family entry** | ❌ Only `ocr.ppocr` exists | **Add** |
| **`OcrRowsForModelType("doctr")` C++ family fallback** | ❌ Returns empty (no entry in `kMap`) | **Add via regenerate** |
| **`iso6391HintsForOcrModelType("doctr")` TS family fallback** | ❌ Returns `undefined` | **Add via regenerate** |
| **`catalogHints.test.ts` doctr case** | ❌ Only ppocr tested | **Add** |
| **OCR hints test (`hints.test.ts`) doctr cases** | ❌ Only ppocr tested | **Add** |
| **C++ model_detect_test doctr-specific unit tests** | ❌ Only fixture-driven | **Add** |
| **`buildCatalogHintsMap` doctr round-trip** | ❌ Not tested | **Add** |

---

## 1  Current Detect State — What Is Done vs Incomplete

### 1.1  C++ Detect (FULLY DONE)

All C++ detect logic is complete and tested:

- **`CanDoctrLayout()`** — `sherpa-onnx-model-detect-ocr.cpp:161–166`
  Checks `det.onnx + rec.onnx + ocr_manifest.json`.
- **`InferDoctrNameOnly()`** — `:146–151`
  Name-only heuristic for `doctr`, `onnxtr`, `doc-tr`, `doc_tr` substrings.
- **`kDoctrReqs`** — `sherpa-onnx-validate-ocr.cpp:15–20`
  `det` + `rec` + `manifest` required; `cls` + `rec_dict` optional.
- **`ParseOcrModelTypeStrict()`** — `:24–32`
  Aliases: `doctr`, `onnxtr`, `doc-tr`, `doc_tr` → `kDoctr`.
- **`ParseOcrModelTypeLocal()`** — `sherpa-onnx-validate-custom.cpp:82–90`
  Same aliases. ✅ Fixed in Phase 3.
- **`DetectOcrModelFromFiles()`** — `:168–300`
  Auto mode: ppocr preferred when both capable; doctr via fallbackOrder.
  Explicit mode: validates `canDoctr` before selecting.
  Fills `paths.manifest` for doctr.
- **`OcrModelPathsToStringMap()`** — `sherpa-onnx-model-path-fill.cpp`
  Includes `manifest` key.
- **`OcrDetect.cpp` bridge** — propagates `manifestPath` from native result. ✅
- **Unified detect** — `DetectModelInternal()` calls `DetectOcrModel()` with `OcrModelKindToString()` handling `kDoctr → "doctr"`. ✅
- **`ValidateOcrPaths(kDoctr, ...)` + `GetOcrPathRequirements(kDoctr)`** — both dispatch via `kDoctrReqs`. ✅

### 1.2  Path Fill (FULLY DONE)

`FillOcrCatalogHeuristics()` calls `FillDerivedCatalogMetadataFromBasename()` for
quantization/sizeTier/language extraction, then `AppendCuratedOcrLanguageRowsIfEmpty()`.

The curated language flow works correctly **for pack-specific lookups** (pack id/stem → `OcrPackRowsForModelKey()`
returns doctr-mobile / doctr-default rows from the generated `model_language_catalog.inc.h`).

**Gap**: The family-level fallback `OcrRowsForModelType("doctr")` returns empty because `catalog.json`
only has `ocr.ppocr`. When no pack match is found, the curated catalog returns nothing for doctr.
This matters for unknown/future doctr packs whose names aren't in `sources.csv`.

### 1.3  TS Detect (FULLY DONE)

- `detectOcrModel()` extracts `manifest` path, has family-aware success check.
- `isOcrDoctrDetectSuccess()` guard narrows correctly.
- `OcrDetectNativeResult.paths.manifest` declared.
- `OcrDoctrSuccessPaths` type exported.
- All Phase 3 Jest tests pass.

### 1.4  Download Registration (FULLY DONE)

- `ModelCategory.Ocr` registered in `catalogDetectCategories.ts`.
- `CATEGORY_CONFIG[ModelCategory.Ocr]` → `{ tag: 'ocr-models', cacheFile: 'ocr-models.json', baseDir: '.../ocr' }`.
- `githubXdcobraProvider` supports `ModelCategory.Ocr` → tag `'ocr-models'`.
- `isAssetSupportedForCategory(ModelCategory.Ocr, name, ext)` → accepts `tar.bz2`.

### 1.5  Fixtures + Collect (FULLY DONE)

- `test/fixtures/ocr-models-structure.txt` has `doctr-default` and `doctr-mobile` blocks.
- `test/fixtures/ocr-models-expected.csv` has `doctr-default.tar.bz2,doctr` and `doctr-mobile.tar.bz2,doctr`.
- `collect-model-structures.yml` has `ocr` stream.
- `models-publish-ocr.yml` workflow exists.

### 1.6  Sources.csv (FULLY DONE)

`scripts/ocr-models/sources.csv` has both doctr rows:
```
doctr-mobile;doctr;...;en,fr
doctr-default;doctr;...;en,fr,pt,es,de,it,cs,pl,da,no,sv,fi,nl,hu,ro
```

### 1.7  Generated Pack Maps (FULLY DONE)

`yarn generate:model-language-catalog` already includes doctr pack entries:
- `OCR_PACK_ISO6391_HINTS_BY_ID["doctr-default"]` → 15 languages
- `OCR_PACK_ISO6391_HINTS_BY_ID["doctr-mobile"]` → `["en", "fr"]`
- C++ `OcrPackRowsForModelKey("doctr-default")` → 15 PublicLanguageRows
- C++ `OcrPackRowsForModelKey("doctr-mobile")` → 2 PublicLanguageRows

---

## 2  Gaps — What Phase 4 Must Add

### 2.1  `catalog/model-language-catalog.json` — Add `ocr.doctr` Family Entry

**Currently**: Only `ocr.ppocr` with hints + entries.

**Needed**: `ocr.doctr` with family-level hints for the doctr family fallback. This is the
union of languages across all doctr packs (doctr-default languages ⊃ doctr-mobile languages),
used when a doctr pack isn't in `sources.csv` yet.

```json
{
  "ocr": {
    "ppocr": { ... },
    "doctr": {
      "hints": ["en", "fr", "pt", "es", "de", "it", "cs", "pl", "da", "no", "sv", "fi", "nl", "hu", "ro"]
    }
  }
}
```

**Rationale**: `doctr-default` is the broadest doctr pack (15 languages). Future doctr packs
should be subsets. If a future pack adds new languages, the family hints array grows.

No `entries` array needed (doctr doesn't have per-language models like ppocr v6 does).

### 2.2  Regenerate Generated Catalog Files

After adding `ocr.doctr` to `catalog.json`, run:

```bash
yarn generate:model-language-catalog
```

This regenerates:
- `android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h`
  - `OcrRowsForModelType("doctr")` will return the 15-language row vector.
- `src/model-languages/generated/catalog.ts`
  - `iso6391HintsForOcrModelType("doctr")` will return the 15-hint array.
  - New exports: `DOCTR_ISO6391_HINTS` (or folded into family map).

### 2.3  Update `generate-model-language-catalog.mjs` Validation

**Currently** (`line ~197`):
```js
if (!catalog.ocr.ppocr?.hints?.length) {
  throw new Error('ocr.ppocr.hints must be a non-empty array');
}
if (!catalog.ocr.ppocr?.entries?.length) {
  throw new Error('ocr.ppocr.entries must be a non-empty array');
}
```

**Add** doctr validation:
```js
if (!catalog.ocr.doctr?.hints?.length) {
  throw new Error('ocr.doctr.hints must be a non-empty array');
}
```

No entries validation for doctr (doctr doesn't use picker entries).

### 2.4  Update `emitTs()` OCR Family Hints Section

**Currently** (`lines ~740–805`): Emits `PPOCR_LANGUAGES`, `PPOCR_ISO6391_HINTS`, and
`iso6391HintsForOcrModelType()` with only ppocr family fallback.

**Add**:
- Emit `DOCTR_ISO6391_HINTS` const from `catalog.ocr.doctr.hints`.
- Update `iso6391HintsForOcrModelType()` to handle `type === 'doctr'`:

```ts
if (type === 'doctr') {
  return [...DOCTR_ISO6391_HINTS];
}
```

This should be inserted between the pack-first lookup (step 1–2) and the ppocr family
fallback (step 3) in the generated function.

### 2.5  Update `emitCpp()` OCR Family Rows

**No manual changes needed** — the generator already iterates `catalog.ocr` entries:
```js
for (const [modelType, spec] of Object.entries(catalog.ocr)) {
  if (spec.hints) { /* emit row */ }
}
```

Adding `ocr.doctr` with `hints` will automatically add `{"doctr", {...}}` to the
`OcrRowsForModelType` map in the generated C++ header.

### 2.6  Update `iso6391HintsForOcrModelType()` Generation Logic

**Currently** (`lines ~776–805`), the generated function has this fallback logic:
```ts
// 3) Family fallback for ppocr / auto / type-only queries.
if (!key || type === 'ppocr' || type === 'auto' || type === '') {
  ...
  return [...PPOCR_ISO6391_HINTS];
}
```

**Need to add** a doctr-specific branch. The generator script should emit:
```ts
// 3a) doctr family fallback
if (type === 'doctr') {
  return [...DOCTR_ISO6391_HINTS];
}
// 3b) ppocr / auto / type-only fallback
if (!key || type === 'ppocr' || type === 'auto' || type === '') {
  ...
}
```

**Implementation**: Update the `emitTs()` function's OCR section to iterate `catalog.ocr` entries
and emit family fallback branches for each family with hints, not just hardcoded ppocr.

---

## 3  Download / Asset Registration — Already Complete

### 3.1  How ppocr Assets Are Registered (Reference)

1. GitHub release `XDcobra/react-native-sherpa-onnx` tag `ocr-models` hosts `.tar.bz2` archives.
2. `githubXdcobraProvider.supportsCategory(Ocr)` → `true`.
3. `githubXdcobraProvider.listModels(Ocr)` fetches release assets, filters by `isAssetSupportedForCategory()` (accepts `tar.bz2`).
4. `buildSourceModelsFromGithubReleaseAssets()` creates `SourceAssetEntry[]`.
5. `buildCatalogHintsMap(Ocr, ids)` calls `detectModelsBatch()` with asset names → unified detect → name-only OCR detect → `kPpocr` or `kDoctr` + language hints.
6. Hints merged into `ModelMeta` → UI shows model type + languages.

### 3.2  Doctr Assets Already Follow Same Path

- `doctr-mobile.tar.bz2` and `doctr-default.tar.bz2` are on the `ocr-models` tag.
- `isAssetSupportedForCategory(Ocr, 'doctr-mobile.tar.bz2', 'tar.bz2')` → `true`.
- `detectModelsBatch([{ assetName: 'doctr-mobile' }])` → unified detect → `InferDoctrNameOnly('doctr-mobile')` → `true` → name-only kDoctr → `{ category: 'ocr', modelType: 'doctr' }`.
- `OcrPackRowsForModelKey('doctr-mobile')` → `[{en, en}, {fr, fr}]` ✅.

**No new asset IDs, download paths, or source registrations needed.**

---

## 4  Language Catalog — `ocr.ppocr` → `ocr.doctr` Pattern

### 4.1  Current `ocr.ppocr` Pattern

| Layer | File | What exists |
|-------|------|-------------|
| SSOT JSON | `catalog/model-language-catalog.json` → `ocr.ppocr` | `hints[]`, `entries[]` |
| Pack CSV | `scripts/ocr-models/sources.csv` | Per-pack languages |
| Generator | `scripts/generate-model-language-catalog.mjs` | Reads both, emits TS + C++ |
| C++ family | `model_language_catalog.inc.h` → `OcrRowsForModelType("ppocr")` | Family-level row vector |
| C++ pack | `model_language_catalog.inc.h` → `OcrPackRowsForModelKey(id)` | Per-pack row vectors |
| TS family | `catalog.ts` → `PPOCR_ISO6391_HINTS` | Family-level hints array |
| TS pack | `catalog.ts` → `OCR_PACK_ISO6391_HINTS_BY_ID` | Per-pack hint arrays |
| TS resolver | `catalog.ts` → `iso6391HintsForOcrModelType()` | Pack-first → family fallback |
| TS exports | `src/model-languages/ocr/index.ts` | Re-exports generated symbols |
| Native resolver | `model_language_catalog.cpp` → `AppendCuratedOcrLanguageRowsIfEmpty()` | Pack-first → family fallback |

### 4.2  What to Add for `ocr.doctr`

| Layer | Change |
|-------|--------|
| SSOT JSON | Add `ocr.doctr.hints` array |
| Pack CSV | Already has doctr rows ✅ |
| Generator validation | Add `ocr.doctr.hints` check |
| Generator TS emit | Emit `DOCTR_ISO6391_HINTS`; add `type === 'doctr'` branch in `iso6391HintsForOcrModelType()` |
| Generator C++ emit | Auto-included via `catalog.ocr` iteration ✅ |
| TS exports | Add `DOCTR_ISO6391_HINTS` re-export in `src/model-languages/ocr/index.ts` |
| Native resolver | No change — `OcrRowsForModelType("doctr")` will auto-resolve after regeneration |

### 4.3  `resolvePublicLanguageHints` / `publicLanguageHintsFromNative`

No changes needed. The flow is:
1. C++ detect fills `derivedLanguages` from `OcrPackRowsForModelKey()` (pack-first).
2. If empty, falls back to `OcrRowsForModelType(modelType)` (family-level).
3. TS `publicLanguageHintsFromNative()` normalizes the rows.

Once `OcrRowsForModelType("doctr")` is populated, the family fallback works.

---

## 5  Collect-Fixtures / Expected CSV

### 5.1  Current State — Complete

- `test/fixtures/ocr-models-structure.txt` includes:
  ```
  # Asset: doctr-default.tar.bz2
  doctr-default/
  doctr-default/det.onnx
  doctr-default/LICENSE
  doctr-default/rec.onnx
  doctr-default/ocr_manifest.json
  ```
  (and `doctr-mobile` similarly)

- `test/fixtures/ocr-models-expected.csv`:
  ```
  doctr-default.tar.bz2,doctr
  doctr-mobile.tar.bz2,doctr
  ```

- C++ `DetectOcrFromFileListMatchesExpected` test already iterates these fixtures and
  validates `kDoctr` detection with correct paths (`manifest` non-empty, `rec_dict` empty).

### 5.2  Workflow

- `collect-model-structures.yml` with `stream: ocr` fetches from `ocr-models` tag.
- **No action needed** — fixtures are up to date. Collect was already run.

---

## 6  ValidateCustom Gaps — None Remaining

All `ValidateCustom` paths for doctr are handled:

- `ParseOcrModelTypeLocal("doctr")` → `kDoctr` ✅
- `GetOcrPathRequirements(kDoctr)` → `[det(req), rec(req), manifest(req), cls(opt), rec_dict(opt)]` ✅
- `ValidateOcrPaths(kDoctr, paths, dir)` → checks required fields ✅
- `FillOcrModelPathsFromStringMap(paths, ocrPaths)` in `sherpa-onnx-model-path-fill.cpp` handles
  `manifest` key ✅

---

## 7  File-by-File Change List

### 7.1  `catalog/model-language-catalog.json`

Add `ocr.doctr` sibling to existing `ocr.ppocr`:

```json
"doctr": {
  "hints": ["en", "fr", "pt", "es", "de", "it", "cs", "pl", "da", "no", "sv", "fi", "nl", "hu", "ro"]
}
```

These are the doctr-default languages (superset of doctr-mobile).

### 7.2  `scripts/generate-model-language-catalog.mjs`

**A) Validation** — add after the ppocr validation (~line 199):
```js
if (!catalog.ocr.doctr?.hints?.length) {
  throw new Error('ocr.doctr.hints must be a non-empty array');
}
```

**B) TS emit** — update the OCR family section (~lines 740–805):

Currently, the ppocr entries/hints are emitted, then `iso6391HintsForOcrModelType()` only
handles ppocr. Refactor to:

1. Emit `DOCTR_ISO6391_HINTS = [...]` const from `catalog.ocr.doctr.hints`.
2. In `iso6391HintsForOcrModelType()`, add after pack-first lookup:
   ```ts
   if (type === 'doctr') {
     return [...DOCTR_ISO6391_HINTS];
   }
   ```
3. Keep ppocr logic unchanged.

**Recommendation**: Generalize the OCR family iteration. Currently ppocr is hardcoded; iterate
`Object.entries(catalog.ocr)` for each family with hints:
```js
for (const [family, spec] of Object.entries(catalog.ocr)) {
  if (spec.hints) {
    const constName = `${family.toUpperCase()}_ISO6391_HINTS`;
    lines.push(`export const ${constName} = ${JSON.stringify(spec.hints)} as const;`);
  }
}
```
Then emit family-specific `if` branches in `iso6391HintsForOcrModelType()`.

**C) C++ emit** — no changes needed. The `emitCpp()` function already iterates `catalog.ocr`
entries and adds them to `OcrRowsForModelType` map.

### 7.3  Generated files (auto-updated by `yarn generate:model-language-catalog`)

**`src/model-languages/generated/catalog.ts`** — will gain:
- `DOCTR_ISO6391_HINTS` export
- `iso6391HintsForOcrModelType("doctr")` returns `[...DOCTR_ISO6391_HINTS]`

**`android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h`** — will gain:
- `OcrRowsForModelType("doctr")` → row vector with 15 PublicLanguageRows

### 7.4  `src/model-languages/ocr/index.ts`

Add `DOCTR_ISO6391_HINTS` to the re-exports:

```ts
export {
  OCR_PACK_ISO6391_HINTS_BY_ID,
  OCR_PACK_ISO6391_HINTS_BY_STEM,
  PPOCR_ISO6391_HINTS,
  PPOCR_LANGUAGES,
  DOCTR_ISO6391_HINTS,          // ← new
  getPpocrLanguages,
  iso6391HintsForOcrModelType,
  ocrPackLanguageStem,
} from '../generated/catalog';
```

### 7.5  NO CHANGES NEEDED — Already Complete

The following files require **no modifications** in Phase 4:

| File | Reason |
|------|--------|
| `src/ocr/types.ts` | `OcrModelType`, `OcrDoctrOptions`, `isOcrDoctrDetectSuccess` all done |
| `src/ocr/index.ts` | `detectOcrModel()` handles manifest; family-aware success |
| `src/ocr/ocrNativeBridge.ts` | Doctr options flattened |
| `src/NativeSherpaOnnx.ts` | `OcrDetectNativeResult.paths.manifest` declared |
| `src/types/modelDetect.ts` | `OcrDoctrSuccessPaths`, `OcrDetectModelResult` complete |
| `android/src/main/cpp/ocr/OcrDetect.cpp` | `manifestPath` propagated |
| `android/src/main/cpp/ocr/OcrDetect.h` | `manifestPath` field present |
| `android/src/main/cpp/ocr/OcrFactory.cpp` | Doctr branch exists |
| `android/src/main/cpp/jni/ocr/sherpa-onnx-ocr-jni.cpp` | `manifest` + doctr options |
| `ios/ocr/bridge/SherpaOnnx+OCR.mm` | `manifestPath` + doctr thresholds |
| `SherpaOnnx.podspec` | `ocr/doctr` include path present |
| `android/src/main/cpp/CMakeLists.txt` | Doctr sources listed |
| `android/src/main/cpp/jni/model_detect/ocr/*` | Detect + validate complete |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-validate-custom.cpp` | `ParseOcrModelTypeLocal` handles doctr |
| `android/src/main/cpp/jni/model_detect/common/model_language_catalog.cpp` | `AppendCuratedOcrLanguageRowsIfEmpty` + `InferOcrModelTypeFromKey` handle doctr |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect-unified.cpp` | `OcrModelKindToString(kDoctr)` correct |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-path-fill.cpp` | `OcrModelPathsToStringMap` includes manifest |
| `src/download/paths.ts` | `ModelCategory.Ocr` → `ocr-models` tag |
| `src/download/catalogDetectCategories.ts` | `ModelCategory.Ocr` in set |
| `src/download/sources/builtin/github-xdcobra.ts` | `Ocr` → `'ocr-models'` |
| `src/download/sources/github-asset-rules.ts` | `Ocr` → `tar.bz2` |
| `scripts/ocr-models/sources.csv` | Doctr rows present |
| `test/fixtures/ocr-models-structure.txt` | Doctr blocks present |
| `test/fixtures/ocr-models-expected.csv` | Doctr entries present |
| `test/cpp/model_detect/model_detect_test_utils.cpp` | `OcrKindFromString("doctr")` handles aliases |
| `.github/workflows/collect-model-structures.yml` | `ocr` stream configured |
| `.github/workflows/models-publish-ocr.yml` | Exists |

---

## 8  Workflows to Run

| Workflow | Action | Why |
|----------|--------|-----|
| `yarn generate:model-language-catalog` | **Run locally** | Regenerate C++ + TS from updated catalog.json |
| `yarn test` (Jest) | **Run locally** | Verify all TS tests pass with new hints |
| `ctest -R model_detect_test` | **Run locally** | Verify C++ fixture tests pass with regenerated inc.h |
| `ctest -R curated_language_catalog_test` | **Run locally** | Verify C++ catalog tests |
| `ctest -R doctr_host_test` | **Run locally** (needs pack) | Verify golden tests still pass |
| `collect-model-structures.yml` | **Not needed** | Fixtures already up to date |
| `models-publish-ocr.yml` | **Not needed** | Packs already published |
| `test-ocr-host.yml` | **Run in CI** | Full C++ OCR test suite |

---

## 9  Tests to Add for Phase 4

### 9.1  Jest — `src/model-languages/ocr/__tests__/hints.test.ts`

**A) Doctr family hints:**
```ts
it('iso6391HintsForOcrModelType returns doctr family hints', () => {
  const hints = iso6391HintsForOcrModelType('doctr');
  expect(hints).toBeDefined();
  expect(hints).toContain('en');
  expect(hints).toContain('fr');
  expect(hints!.length).toBeGreaterThanOrEqual(2);
});
```

**B) Doctr pack-first lookup still wins:**
```ts
it('iso6391HintsForOcrModelType prefers doctr-mobile pack over family', () => {
  const mobile = iso6391HintsForOcrModelType('doctr', 'doctr-mobile');
  expect(mobile).toEqual(['en', 'fr']);
});

it('iso6391HintsForOcrModelType prefers doctr-default pack over family', () => {
  const dflt = iso6391HintsForOcrModelType('doctr', 'doctr-default');
  expect(dflt).toContain('en');
  expect(dflt).toContain('pt');
  expect(dflt).toContain('ro');
  expect(dflt!.length).toBe(15);
});
```

**C) DOCTR_ISO6391_HINTS exported:**
```ts
it('DOCTR_ISO6391_HINTS contains family-level hints', () => {
  expect(DOCTR_ISO6391_HINTS).toBeDefined();
  expect(DOCTR_ISO6391_HINTS.length).toBeGreaterThanOrEqual(2);
  expect(DOCTR_ISO6391_HINTS).toContain('en');
  expect(DOCTR_ISO6391_HINTS).toContain('fr');
});
```

**D) publicLanguageHintsFromNative for doctr (integration):**
```ts
it('publicLanguageHintsFromNative resolves doctr family hints from native rows', () => {
  const resolved = publicLanguageHintsFromNative({
    domain: ModelCategory.Ocr,
    modelType: 'doctr',
    modelKey: 'doctr-mobile',
    rawRows: [
      { iso6391Hint: 'en', id: 'en' },
      { iso6391Hint: 'fr', id: 'fr' },
    ],
  });
  expect(resolved).toEqual([
    { iso6391Hint: 'en', id: 'en' },
    { iso6391Hint: 'fr', id: 'fr' },
  ]);
});
```

### 9.2  Jest — `src/download/__tests__/catalogHints.test.ts`

**Add doctr case in the `buildCatalogHintsMap — OCR` describe block:**

```ts
it('merges name-only unified detect language hints for doctr packs', async () => {
  mockDetectModelsBatch.mockResolvedValue([
    {
      matched: true,
      category: ModelCategory.Ocr,
      modelType: 'doctr',
      languages: ['en', 'fr'],
      quantization: 'unknown',
      sizeTier: 'unknown',
      isStreaming: false,
    },
  ]);

  const hints = await buildCatalogHintsMap(ModelCategory.Ocr, [
    'doctr-mobile',
  ]);

  expect(hints.get('doctr-mobile')).toEqual({
    modelType: 'doctr',
    languages: ['en', 'fr'],
    quantization: 'unknown',
    sizeTier: 'unknown',
    isStreaming: false,
  });
  expect(mockDetectModelsBatch).toHaveBeenCalledWith([
    { assetName: 'doctr-mobile' },
  ]);
});
```

### 9.3  C++ — `test/cpp/model_detect/model_detect_test.cpp`

**A) Doctr file-list detect (standalone, not fixture-driven):**

```cpp
TEST(ModelDetectTest, DetectOcrDoctrFromFileList) {
    const std::string root = "doctr-test-pack";
    std::vector<std::string> lines = {
        root + "/",
        root + "/det.onnx",
        root + "/rec.onnx",
        root + "/ocr_manifest.json",
    };
    auto files = model_detect_test::BuildFileEntriesFromPathLines(root, lines);
    auto result = sherpaonnx::DetectOcrModelFromFileList(files, root, "auto");
    ASSERT_TRUE(result.ok) << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::OcrModelKind::kDoctr);
    EXPECT_FALSE(result.paths.det.empty());
    EXPECT_FALSE(result.paths.rec.empty());
    EXPECT_FALSE(result.paths.manifest.empty());
    EXPECT_TRUE(result.paths.rec_dict.empty());
}
```

**B) Explicit doctr type:**

```cpp
TEST(ModelDetectTest, DetectOcrExplicitDoctrType) {
    const std::string root = "onnxtr-pack";
    std::vector<std::string> lines = {
        root + "/",
        root + "/det.onnx",
        root + "/rec.onnx",
        root + "/ocr_manifest.json",
    };
    auto files = model_detect_test::BuildFileEntriesFromPathLines(root, lines);
    auto result = sherpaonnx::DetectOcrModelFromFileList(files, root, "doctr");
    ASSERT_TRUE(result.ok) << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::OcrModelKind::kDoctr);
}
```

**C) Doctr fails without manifest:**

```cpp
TEST(ModelDetectTest, DetectOcrDoctrFailsWithoutManifest) {
    const std::string root = "doctr-no-manifest";
    std::vector<std::string> lines = {
        root + "/",
        root + "/det.onnx",
        root + "/rec.onnx",
    };
    auto files = model_detect_test::BuildFileEntriesFromPathLines(root, lines);
    auto result = sherpaonnx::DetectOcrModelFromFileList(files, root, "doctr");
    EXPECT_FALSE(result.ok);
}
```

**D) Doctr name-only detection:**

```cpp
TEST(ModelDetectTest, DetectOcrDoctrNameOnly) {
    auto result = sherpaonnx::DetectOcrModelFromFileList(
        {}, "doctr-mobile", "auto");
    EXPECT_FALSE(result.ok);  // name-only = ok=false
    EXPECT_EQ(result.selectedKind, sherpaonnx::OcrModelKind::kDoctr);
    EXPECT_EQ(result.detectionSources.size(), 2u);  // nameOnly + dirName
}
```

### 9.4  C++ — `test/cpp/model_detect/curated_language_catalog_test.cpp`

**Add doctr family fallback test:**

```cpp
TEST(CuratedLanguageCatalog, OcrDoctrFamilyRowsNonEmpty) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& rows = OcrRowsForModelType("doctr");
    ASSERT_FALSE(rows.empty()) << "OcrRowsForModelType(\"doctr\") should return family hints";
    bool hasEn = false;
    for (const auto& r : rows) {
        if (r.iso6391Hint == "en") hasEn = true;
    }
    EXPECT_TRUE(hasEn);
}

TEST(CuratedLanguageCatalog, OcrDoctrPackRowsForKnownIds) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& mobile = OcrPackRowsForModelKey("doctr-mobile");
    ASSERT_FALSE(mobile.empty());
    EXPECT_EQ(mobile.size(), 2u);  // en, fr

    const auto& dflt = OcrPackRowsForModelKey("doctr-default");
    ASSERT_FALSE(dflt.empty());
    EXPECT_EQ(dflt.size(), 15u);
}
```

---

## 10  Acceptance Checklist

### Catalog & Language Hints

- [ ] `catalog/model-language-catalog.json` has `ocr.doctr.hints` (15 languages)
- [ ] `yarn generate:model-language-catalog` succeeds without errors
- [ ] `DOCTR_ISO6391_HINTS` exported from `src/model-languages/generated/catalog.ts`
- [ ] `iso6391HintsForOcrModelType('doctr')` returns 15-element array
- [ ] `iso6391HintsForOcrModelType('doctr', 'doctr-mobile')` returns `['en', 'fr']` (pack-first)
- [ ] `OcrRowsForModelType("doctr")` in C++ `model_language_catalog.inc.h` returns 15 rows
- [ ] `OcrPackRowsForModelKey("doctr-mobile")` returns 2 rows (unchanged)
- [ ] `DOCTR_ISO6391_HINTS` re-exported from `src/model-languages/ocr/index.ts`

### Download & Asset Registration (Verification Only)

- [ ] `doctr-mobile.tar.bz2` and `doctr-default.tar.bz2` listed in `ocr-models` release
- [ ] Unified detect name-only: `detectModelsBatch([{ assetName: 'doctr-mobile' }])` → `{ category: 'ocr', modelType: 'doctr' }`
- [ ] `buildCatalogHintsMap(Ocr, ['doctr-mobile'])` returns hint with `modelType: 'doctr'`

### Tests — Green

- [ ] `jest --testPathPattern ocr` — all OCR tests pass
- [ ] `jest --testPathPattern catalogHints` — doctr case passes
- [ ] `jest --testPathPattern hints` — doctr family + pack tests pass
- [ ] `ctest -R model_detect_test` — doctr file-list + name-only + fixture tests pass
- [ ] `ctest -R curated_language_catalog_test` — doctr family + pack rows tests pass
- [ ] `ctest -R doctr_host_test` — golden tests pass (if pack available)

### Regression

- [ ] All existing ppocr tests unchanged and passing
- [ ] `iso6391HintsForOcrModelType('ppocr')` still returns ppocr hints
- [ ] `OcrRowsForModelType("ppocr")` still returns ppocr rows
- [ ] `detectOcrModel()` with ppocr pack still works

---

## 11  What NOT To Do (Phase 5: Documentation & Integration Tests)

| Excluded | Why | Deferred to |
|----------|-----|-------------|
| End-to-end Android/iOS integration test with real doctr pack download | E2E test scope; requires device | Phase 5 |
| Offline OCR API documentation updates for doctr | Phase 5 documentation | Phase 5 |
| Consumer app (VoiceLab) integration of doctr packs | App-layer concern | Phase 5 |
| Per-language model selection for doctr (vocab switching) | Doctr packs are single-vocab; no per-language model needed | Future |
| Word-level granularity in DoctrBackend | Backend limitation, not catalog/detect | Future |
| Additional doctr pack variants (e.g. quantized, int8) | Separate pack-publish workflow | Future |
| Changes to `createOCR` / `recognize` API signatures | Frozen per Phase 2–3 contract | Never |
| Refactoring the OCR catalog to use a different JSON schema | Would break existing ppocr flow | Never |

---

## 12  Implementation Order

1. **`catalog/model-language-catalog.json`** — add `ocr.doctr.hints`
2. **`scripts/generate-model-language-catalog.mjs`** — add doctr validation + TS emit for doctr family fallback
3. **`yarn generate:model-language-catalog`** — regenerate `catalog.ts` + `model_language_catalog.inc.h`
4. **`src/model-languages/ocr/index.ts`** — add `DOCTR_ISO6391_HINTS` re-export
5. **Jest tests** — add doctr cases to `hints.test.ts`, `catalogHints.test.ts`
6. **C++ tests** — add doctr cases to `model_detect_test.cpp`, `curated_language_catalog_test.cpp`
7. **Run all tests** — `yarn test`, `ctest`, verify green
8. **Commit** — single commit covering catalog + generator + generated + tests
