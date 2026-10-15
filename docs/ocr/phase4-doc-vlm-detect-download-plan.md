# Phase 4 — `doc_vlm` Detect / Download / Language Catalog

> Branch: `feat/add-ocr-doc-vlm`
> Prereqs: Phase 1 pack `docvlm-granite-258m` published on tag `ocr-models`. Phase 2 `DocVlmBackend`. Phase 3 factory + TS API. `isOcrDocVlmDetectSuccess` already requires the eight path strings below. `CreateOcrBackend("doc_vlm")` already returns `Family() == "doc_vlm"`.
> High-level contract: [`.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md`](../../.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md)
> Path contract this phase emits: [phase3-doc-vlm-public-api-plan.md](phase3-doc-vlm-public-api-plan.md) §2.6
> Pack layout and manifest schema: [phase1-doc-vlm-packs-plan.md](phase1-doc-vlm-packs-plan.md) §3–§4

This phase makes a granite pack detectable, downloadable as an OCR asset, and annotated with curated languages. It does not change recognize, DocTags, or the docs in `docs/ocr-offline.md`.

---

## 0  Executive summary

Doctr detect is already finished. `doc_vlm` detect is not. The published pack, the fixture listing, the pack-language rows, and the TS success guard are already in the tree. Native detect still has two kinds (`kPpocr`, `kDoctr`) and will not fill the eight paths Phase 3 already type-checks.

| Area | Current state | Phase 4 |
| --- | --- | --- |
| `OcrModelKind` | `kUnknown`, `kPpocr`, `kDoctr` | Add `kDocVlm` |
| `CanDocVlmLayout` / name aliases | Absent. `docvlm-granite-258m` is not inferred | Add. Check these aliases before the doctr aliases |
| `ocr_manifest.json` `family` | Filename only. JSON is never read | Read `family` when the file is on disk |
| `ValidateOcrPaths` / `GetOcrPathRequirements` | ppocr + doctr | Eight required keys for `kDocVlm` |
| Path fill + unified kind string | `det/rec/cls/rec_dict/manifest` | Add the eight keys. `OcrModelKindToString(kDocVlm)` → `"doc_vlm"` |
| `ocr::DetectOcrModel` bridge | Copies five paths. `KindToFamily` has no `kDocVlm` arm | Copy the eight paths. Return `modelType` `"doc_vlm"` |
| JNI / iOS / Kotlin detect maps | Drop any key other than det/rec/cls/dict/manifest | Emit the eight keys on `paths` and `files` |
| TS `detectOcrModel` / `isOcrDocVlmDetectSuccess` | Done in Phase 3 | Leave the guard. Native must now satisfy it |
| `OcrEngine::Load("auto")` | Already calls `ocr::DetectOcrModel` and passes `detect.modelType` to `CreateOcrBackend` | Works once the bridge returns `"doc_vlm"` |
| Fixtures | `ocr-models-structure.txt` and `ocr-models-expected.csv` already list `docvlm-granite-258m.tar.bz2,doc_vlm` | Stop skipping that row. The fixture loop currently `continue`s because `OcrKindFromString("doc_vlm")` is `kUnknown` |
| Catalog domain `ocr.doc_vlm` | Absent. `iso6391HintsForOcrModelType('doc_vlm')` is `undefined` on purpose (Phase 1) | Add hints `en, ja, ar, zh` and regenerate |
| Pack rows for `docvlm-granite-258m` | Already in `catalog.ts` and `model_language_catalog.inc.h` | Leave the CSV row. Family fallback is the new layer |
| Download | `ModelCategory.Ocr` → tag `ocr-models`, extension `tar.bz2` | Verify `docvlm-granite-258m.tar.bz2` passes the existing filter. No new category |
| Docs / host E2E / example app | Out of scope | Phase 5, except the example app which stays out of the epic |

---

## 1  Eight paths

These are the only success paths. They match `DOC_VLM_PATH_KEYS` in `src/ocr/types.ts` and `OcrDocVlmSuccessPaths` in `src/types/modelDetect.ts`.

| Key | Basename in the pack root |
| --- | --- |
| `vision_encoder` | `vision_encoder.onnx` |
| `vision_encoder_data` | `vision_encoder.onnx_data` |
| `embed_tokens` | `embed_tokens.onnx` |
| `embed_tokens_data` | `embed_tokens.onnx_data` |
| `decoder` | `decoder_model_merged.onnx` |
| `decoder_data` | `decoder_model_merged.onnx_data` |
| `tokenizer` | `tokenizer.json` |
| `manifest` | `ocr_manifest.json` |

`decoder` is the key name. The file is `decoder_model_merged.onnx`.

Resolve each one with `FindFileByName` on that exact basename. v1 has no int8/fp16 twin. `tokenizer_config.json`, `vocab.json`, `merges.txt`, and `config.json` stay in the pack and stay out of the required set. A file named `vision_encoder.onnx.data` (dot before `data`) does not satisfy `vision_encoder_data`.

On a `kDocVlm` hit, leave `det`, `rec`, `cls`, and `rec_dict` empty. `hasDet` / `hasRec` / `hasCls` / `hasRecYml` stay false. Phase 3 completeness does not look at those booleans.

---

## 2  Auto priority

`OcrEngine::Load` resolves the exact string `"auto"` through `ocr::DetectOcrModel` (`OcrEngine.cpp`). Factory `CreateOcrBackend("auto")` stays ppocr. Auto-select of a granite directory happens in detect, then the engine passes the concrete `"doc_vlm"` into the factory that Phase 3 already shipped.

### 2.1  Explicit `modelType`

Explicit type wins over the manifest. Parse with the same alias list as the factory, after `ToLower` (detect is case-insensitive; the factory match in `OcrFactory.cpp` stays case-sensitive and is not edited here):

`doc_vlm`, `docvlm`, `doc-vlm`, `granite-docling`, `docling`

`"DocVlm"` therefore detects as `kDocVlm`. It still does not construct a backend if it is passed straight to `CreateOcrBackend`. That split already exists for other families and stays.

Then require that family's layout:

- `kDocVlm` and `CanDocVlmLayout` is false → error `OCR: doc_vlm layout not found in <dir>`. Do not fall through to doctr.
- `kDoctr` / `kPpocr` keep today's errors.
- Unknown string → `OCR: unknown model type: …` and `kUnknown`.

### 2.2  Auto, manifest `family` readable

When `ocr_manifest.json` exists on disk and contains a `"family"` string:

1. Run that string through the same alias parser.
2. A known family selects that kind. Record `kFileListing` (already added because the file vector is non-empty). Do not add a new `DetectionSource`.
3. If that kind's layout is absent, return an error for that kind. Do not fall through to another family.
4. An unknown family string (`"easyocr"`, empty after parse) is an error: `OCR: ocr_manifest.json family is not a supported OCR family`. Do not guess from filenames.

So a doctr pack whose manifest says `"doctr"` stays doctr even if someone later drops a `vision_encoder.onnx` beside it. A granite pack whose manifest says `"doc_vlm"` stays `doc_vlm` even if `det.onnx` and `rec.onnx` are also present. A manifest that says `"doctr"` on a directory that only has the eight granite files fails as doctr. It does not become `doc_vlm`.

### 2.3  Auto, manifest family unavailable

Unavailable means the manifest path is not a real file (fixture file lists, collect listings) or the file has no `"family"` string. Layout order:

1. `CanDocVlmLayout` — all eight basenames present → `kDocVlm`
2. ppocr — `det` + `rec` + rec dictionary, unchanged → `kPpocr`
3. doctr — `det` + `rec` + `ocr_manifest.json`, unchanged → `kDoctr`

The published granite pack has no `det.onnx` and no `rec.onnx`, so `CanDoctrLayout` is already false for it. Putting `doc_vlm` first still matters for a mixed directory whose JSON cannot be read: the eight-file set must not be reported as doctr. A pure doctr directory (det + rec + manifest, no vision/embed/decoder octet) still resolves to doctr. A pure ppocr directory still resolves to ppocr. ppocr-before-doctr stays as it is when the octet is absent.

Append `"doc_vlm"` to `detectedModels` whenever `CanDocVlmLayout` is true, the same way ppocr and doctr are appended when they are capable. `selectedKind` follows the priority above. Selection and the capable-list are separate.

Update the unrecognized-layout error so it names the octet as well as the ppocr dictionary and the doctr manifest.

### 2.4  Name-only (empty file vector)

Download catalog hints call unified detect with an asset name and no directory. Order:

1. `InferDocVlmNameOnly` — substring `docvlm`, `doc-vlm`, `doc_vlm`, `granite-docling`, or `docling`
2. Existing ppocr tokens
3. Existing doctr tokens (`doctr`, `onnxtr`, `doc-tr`, `doc_tr`)

`docvlm-granite-258m` contains `docvlm` and does not contain `doctr`, `doc-tr`, or `doc_tr`. `docling` does not contain `doctr`. Check the doc_vlm predicate first anyway, and lock it with a test, so a later edit cannot classify that asset as doctr.

Do not match a bare `doc`, `vlm`, or `granite`.

Name-only stays `ok = false` with `kNameOnly` and `kDirName`, same as ppocr and doctr. `OcrKindToModelType` must return `"doc_vlm"` or `AppendCuratedOcrLanguageRowsIfEmpty` returns before the pack-row lookup.

`InferOcrModelTypeFromKey` in `model_language_catalog.cpp` uses the same alias order (doc_vlm tokens, then ppocr, then doctr). That function is the fallback when `selectedKind` is still unknown.

---

## 3  Reading `family`

Do not call `DocVlmManifest::Load`. That parser lives in the backend, throws unless `arch`, dtype, and shapes match, and accepts only `family == "doc_vlm"`. Detect needs one string, and it must also accept `"doctr"` and `"ppocr"`.

Add a local helper next to `FindOcrManifest` in `sherpa-onnx-model-detect-ocr.cpp`:

- Input is the manifest path from `FindFileByName`.
- `FileExists` is false → return “unavailable”. Fixture paths such as `docvlm-granite-258m/ocr_manifest.json` are not on disk. Layout detection must still succeed.
- Read at most 1 MiB. The generated manifest is about 2 KiB. A larger file is treated as unavailable, not as a hard error.
- Scan for the JSON key `"family"` and one JSON string value. Ignore every other key. A tiny scanner in the style of `DocVlmManifest.cpp` is enough. Do not add a JSON library.
- Alias-normalize the value with the parser from §2.1.

Published manifests use `"family": "doc_vlm"` (`phase1` schema). Aliases inside the file are accepted so a hand-written manifest still selects.

---

## 4  `CanDocVlmLayout` and validate

```cpp
bool CanDocVlmLayout(const std::vector<FileEntry>& files) {
  return !FindFileByName(files, "vision_encoder.onnx").empty() &&
         !FindFileByName(files, "vision_encoder.onnx_data").empty() &&
         !FindFileByName(files, "embed_tokens.onnx").empty() &&
         !FindFileByName(files, "embed_tokens.onnx_data").empty() &&
         !FindFileByName(files, "decoder_model_merged.onnx").empty() &&
         !FindFileByName(files, "decoder_model_merged.onnx_data").empty() &&
         !FindFileByName(files, "tokenizer.json").empty() &&
         !FindFileByName(files, "ocr_manifest.json").empty();
}
```

`kDocVlmReqs` in `sherpa-onnx-validate-ocr.cpp` lists those eight keys, all `required: true`. Do not add optional `det` / `rec` / `cls` / `rec_dict` rows. `GetOcrPathRequirements(kDocVlm)` is then exactly the Phase 3 key set, which `ValidateCustom` already dispatches for category `"ocr"` once `ParseOcrModelTypeLocal` knows the aliases.

The `switch` in `GetRequirements` must have a `kDocVlm` arm. The `default` arm returns a null requirement table, and `ValidateOcrPaths` then returns `ok = true` without checking anything.

`OcrModelPaths` gains:

```cpp
std::string vision_encoder;
std::string vision_encoder_data;
std::string embed_tokens;
std::string embed_tokens_data;
std::string decoder;       // decoder_model_merged.onnx
std::string decoder_data;  // decoder_model_merged.onnx_data
std::string tokenizer;     // tokenizer.json
```

`manifest` already exists. Member names are the map keys.

`FillOcrCatalogHeuristics` may keep deriving quantization from `paths.rec`. A doc_vlm result leaves `rec` empty, and `docvlm-granite-258m` has no `int8` / `fp16` token, so quantization stays `unknown`. Do not invent a decoder-filename quant rule in this phase.

---

## 5  Unified detect

`DetectModelInternal` already calls `DetectOcrModel` and maps the kind through `OcrModelKindToString`. Add the `kDocVlm` → `"doc_vlm"` arm. `IsCatalogDetectHit` already treats a name-only inference (`ok == false` plus `kNameOnly`) as a catalog hit. Once the name-only path sets `kDocVlm`, asset `docvlm-granite-258m` comes back as category `ocr`, model type `doc_vlm`.

### 5.1  Directory scan vs whisper / moonshine filenames

On a real directory, STT runs before OCR. These pack basenames collide with STT token search:

- `vision_encoder.onnx` contains `encoder` (`encoderForV2`, and the generic encoder slot).
- `decoder_model_merged.onnx` contains `decoder` and is an explicit moonshine-v2 merged-decoder token.

Auto STT fallback can therefore *select* whisper (`hasWhisper`: encoder + decoder, no joiner) or, if that candidate is skipped, moonshine v2 (`hasMoonshineV2`). Both requirement tables require `tokens.txt`. This pack has `tokenizer.json` and no `tokens.txt`, so `ValidateSttPaths` fails, `ok` stays false, and `IsCatalogDetectHit` is false on a directory scan (no `kNameOnly`). Unified detect then continues and can return OCR.

That fall-through is the intended behavior. Do not relax STT token rules. Do not retune whisper matching in this phase.

Lock it with a unified-detect test on a temp directory that contains the eight basenames (empty files are enough; matching is by name) plus `vocab.json` and `merges.txt` from the real pack listing. Expected: `matched`, category `ocr`, model type `doc_vlm`.

If that test returns `stt` / `whisper` / `moonshine_v2`, the fix is local to the STT return in `DetectModelInternal`: when `DetectOcrModel` is `ok` and `selectedKind == kDocVlm`, return the OCR hit instead of that STT hit. A normal whisper pack has no `ocr_manifest.json` octet, so the override does not reclassify it.

Name-only unified detect does not hit this path. `docvlm-granite-258m` contains none of the STT directory tokens (`whisper`, `moonshine`, `zipformer`, …).

---

## 6  Bridge so the eight paths reach JS

`src/ocr/index.ts` already copies `vision_encoder`, `vision_encoder_data`, `embed_tokens`, `embed_tokens_data`, `decoder`, `decoder_data`, `tokenizer`, and `manifest` from `paths` or `files`. If native omits them, `detectOcrModel` sets `success: false` with the Phase 3 “required paths” error even when C++ `ok` is true.

`OcrEngine::Load("auto")` only needs `detect.modelType`. `detectOcrModel()` needs the path map. Both go through `ocr::DetectOcrModel`.

### 6.1  `android/src/main/cpp/ocr/OcrDetect.h` / `.cpp`

Add eight `std::string` fields beside `manifestPath`. `KindToFamily` returns `"doc_vlm"` for `kDocVlm`. Copy `native.paths.*` into those fields on both the success path and the failure path (a partial detect still surfaces whatever was filled). Leave the `hasDet` / `hasRec` booleans as “path non-empty”.

### 6.2  JNI `sherpa-onnx-ocr-jni.cpp` `nativeDetect`

`PutString` each non-empty key into **both** the `paths` map and the `files` map, using the snake_case key. Same pattern as `manifest` today. No camelCase alias.

### 6.3  `ios/ocr/bridge/SherpaOnnx+OCR.mm` `detectOcrModel`

Same eight keys on `paths` and `files`.

### 6.4  `SherpaOnnxOcrHelper.kt` `detectMapToWritable`

`putPath` currently copies only `det`, `rec`, `cls`, `rec_dict`, and `manifest`. The Kotlin map is rebuilt key by key, so JNI keys that Kotlin does not copy never reach JS on Android. Copy the eight keys into `paths` and into `files` under the same names.

### 6.5  `src/NativeSherpaOnnx.ts`

`OcrDetectNativeResult.paths` already has the eight optional keys. Add the same optional keys on `files`. The reader already indexes `filesRaw` as a record; the type should match what JNI and iOS send.

No change to `isOcrDocVlmDetectSuccess` or to the family completeness branch in `detectOcrModel`.

---

## 7  Language catalog `ocr.doc_vlm`

### 7.1  What is already generated

`scripts/ocr-models/sources.csv` already has:

```text
docvlm-granite-258m;doc_vlm;…;en,ja,ar,zh;onnx-community/granite-docling-258M-ONNX
```

`yarn generate:model-language-catalog` already emitted:

- `OCR_PACK_ISO6391_HINTS_BY_ID["docvlm-granite-258m"]` → `["en", "ja", "ar", "zh"]`
- `OcrPackRowsForModelKey("docvlm-granite-258m")` → four `PublicLanguageRow`s

`src/model-languages/ocr/__tests__/hints.test.ts` asserts the pack hit and asserts `iso6391HintsForOcrModelType('doc_vlm')` is `undefined`. That second assertion is the Phase 1 hold. This phase flips it.

`catalog/model-language-catalog.json` has `ocr.ppocr` and `ocr.doctr` only. `OcrRowsForModelType("doc_vlm")` is empty, so an unknown future pack id with `modelType: "doc_vlm"` gets no family hints.

### 7.2  JSON

Add a sibling of `ocr.doctr`. Hints only. This family has one pack and no per-language picker models, so there is no `entries` array and no `getDoc_vlmLanguages()`.

```json
"doc_vlm": {
  "hints": ["en", "ja", "ar", "zh"]
}
```

Order matches the `languages` column. If a later pack adds a language, the family array becomes the union. Do not copy the ppocr Latin list into this family.

### 7.3  Generator

`scripts/generate-model-language-catalog.mjs` already walks `Object.entries(catalog.ocr)`:

- C++ `OcrRowsForModelType` emits one map entry per family that has `hints`.
- TS emit writes `${family.toUpperCase()}_ISO6391_HINTS`, which becomes `DOC_VLM_ISO6391_HINTS`.
- `iso6391HintsForOcrModelType` already emits `if (type === '<family>')` for every non-ppocr family with hints. `type === 'doc_vlm'` appears between the pack-first lookup and the ppocr / `auto` fallback. `auto` and `ppocr` keep returning `PPOCR_ISO6391_HINTS`.

Add validation next to the doctr checks:

```js
if (!catalog.ocr.doc_vlm?.hints?.length) {
  throw new Error('ocr.doc_vlm.hints must be a non-empty array');
}
```

Do not require `ocr.doc_vlm.entries`. Doctr keeps its entries requirement.

Then run:

```bash
yarn generate:model-language-catalog
```

Commit the regenerated `src/model-languages/generated/catalog.ts` and `android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h`.

### 7.4  Re-export

`src/model-languages/ocr/index.ts` re-exports `DOCTR_ISO6391_HINTS` and `DOCTR_LANGUAGES`. Add `DOC_VLM_ISO6391_HINTS` only.

### 7.5  Kind → catalog type

`OcrKindToModelType` must return `"doc_vlm"` for `kDocVlm`. Otherwise name-only detect of `docvlm-granite-258m` never reaches `OcrPackRowsForModelKey`, and the four languages stay empty even though the pack rows already exist.

Pack lookup stays first inside `CuratedRows` for `ModelLanguageDomain::kOcr`. Family rows apply when the pack id is unknown.

---

## 8  Download

No new category, tag, cache file, or extension rule.

| Piece | Behavior to keep |
| --- | --- |
| `src/download/paths.ts` | `ModelCategory.Ocr` → tag `ocr-models`, cache `ocr-models.json` |
| `github-xdcobra.ts` | `Ocr` → `'ocr-models'` |
| `github-asset-rules.ts` | `Ocr` accepts `tar.bz2` and rejects a bare `.onnx` |
| `catalogDetectCategories.ts` | `Ocr` is in the detect-backed set |
| `isAssetSupportedForCategory(Ocr, 'docvlm-granite-258m.tar.bz2', 'tar.bz2')` | Already true, because every OCR `tar.bz2` is accepted |

Add that filename next to the doctr assertions in `src/download/sources/__tests__/github-asset-rules.test.ts`. That is the automated listing check.

Confirm the release asset is actually published (Phase 1 archive, about 1.1–1.2 GiB). A metadata query is enough:

```bash
gh release view ocr-models --repo XDcobra/react-native-sherpa-onnx --json assets \
  --jq '.assets[].name | select(. == "docvlm-granite-258m.tar.bz2")'
```

Do not download the archive in Jest or in `ctest`. Host download stays on the Phase 5 CI job.

`buildCatalogHintsMap` passes `{ assetName }` into unified detect. After §2.4 and §5, that name-only hit is `modelType: 'doc_vlm'` plus the four pack languages. The Jest in §10.2 mocks `detectModelsBatch` the same way the doctr case does; the C++ name-only test is the one that proves the kind.

---

## 9  Fixtures

Already present. Do not re-run `collect-model-structures.yml` or `models-publish-ocr.yml`.

`test/fixtures/ocr-models-structure.txt` asset `docvlm-granite-258m.tar.bz2` lists the eight required basenames plus the rest of the pack (`vocab.json`, `merges.txt`, `tokenizer_config.json`, configs, `LICENSE`, …). No `det.onnx`, no `rec.onnx`.

`test/fixtures/ocr-models-expected.csv` already has `docvlm-granite-258m.tar.bz2,doc_vlm`.

`DetectOcrFromFileListMatchesExpected` skips any expected type that `OcrKindFromString` maps to `kUnknown`, and it asserts `paths.det` and `paths.rec` for every row it does run. Both must change in the same edit that teaches the helper about `doc_vlm`:

- `kPpocr`: `det`, `rec`, `rec_dict` non-empty (today's asserts).
- `kDoctr`: `manifest` non-empty, `rec_dict` empty (today's asserts).
- `kDocVlm`: all eight paths non-empty; `det`, `rec`, `cls`, and `rec_dict` empty.

Until `OcrKindFromString` learns `doc_vlm`, this fixture is silently ignored. After it learns `doc_vlm`, the old unconditional `det`/`rec` asserts fail the granite row.

---

## 10  Tests

### 10.1  C++ `test/cpp/model_detect/model_detect_test_utils.cpp`

`OcrKindFromString` / `OcrKindToString`: `doc_vlm` and the four aliases → `kDocVlm` / `"doc_vlm"`. Doctr aliases stay doctr. `"docvlm"` must not return `kDoctr`.

### 10.2  C++ `test/cpp/model_detect/model_detect_test.cpp`

Update `DetectOcrFromFileListMatchesExpected` as in §9.

Add file-list cases (synthetic `FileEntry`s, no disk, so manifest JSON is unavailable and §2.3 applies):

| Test | Listing | Request | Expect |
| --- | --- | --- | --- |
| `DetectOcrDocVlmFromFileList` | eight basenames under `docvlm-granite-258m/` | `auto` | `ok`, `kDocVlm`, eight paths set, `det`/`rec`/`rec_dict` empty |
| `DetectOcrExplicitDocVlmAlias` | same eight | `granite-docling` | `ok`, `kDocVlm` |
| `DetectOcrDocVlmFailsWithoutDecoderData` | octet minus `decoder_model_merged.onnx_data` | `doc_vlm` | `ok == false` |
| `DetectOcrDocVlmTokenizerConfigIsNotTokenizer` | octet with `tokenizer_config.json` instead of `tokenizer.json` | `auto` | `ok == false`, kind `kUnknown` |
| `DetectOcrDocVlmNameOnly` | empty files, dir `docvlm-granite-258m` | `auto` | `ok == false`, `kDocVlm`, sources include `kNameOnly` and `kDirName`, not `kDoctr` |
| `DetectOcrDoclingNameOnlyIsDocVlm` | empty files, dir `docling` | `auto` | `kDocVlm` |
| `DetectOcrDoctrNameOnlyUnchanged` | existing `doctr-mobile` case | `auto` | still `kDoctr` |

Manifest-on-disk cases (temp directory via `testing::TempDir()`, empty files, delete in the test):

| Test | On disk | Request | Expect |
| --- | --- | --- | --- |
| Family `doc_vlm` plus the eight files, and also `det.onnx` + `rec.onnx` | `auto` | `kDocVlm`. `det` and `rec` empty. `vision_encoder` set |
| Family `doctr`, eight granite files, plus `det.onnx` + `rec.onnx` + manifest | `auto` | `kDoctr`. Vision paths empty |
| Family `doctr`, eight granite files, no `det.onnx` / `rec.onnx` | `auto` | `ok == false` (doctr layout missing; no fall-through) |
| No `family` key, eight files only | `auto` | `kDocVlm` (§2.3) |
| Eight files, call unified `DetectModel` on that directory | | category `ocr`, model type `doc_vlm` (§5.1) |

`DetectOcrModel(tempDir, "auto")` covers the directory scanner. `DetectOcrModelFromFileList` with the temp paths covers `FileExists` inside the file-list API. One of those two entry points is enough per scenario if both share `DetectOcrModelFromFiles`.

### 10.3  C++ `test/cpp/model_detect/curated_language_catalog_test.cpp`

```cpp
TEST(CuratedLanguageCatalog, OcrDocVlmFamilyRows) {
  const auto& rows = OcrRowsForModelType("doc_vlm");
  ASSERT_EQ(rows.size(), 4u);
  // en, ja, ar, zh — order follows catalog hints
}

TEST(CuratedLanguageCatalog, OcrDocVlmPackRows) {
  const auto& rows = OcrPackRowsForModelKey("docvlm-granite-258m");
  ASSERT_EQ(rows.size(), 4u);
}
```

Name-only language test on `DetectOcrModelFromFileList({}, "docvlm-granite-258m", "auto")`: `derivedLanguages` has `en`, `ja`, `ar`, `zh`, and the last source is `kCuratedCatalog`. This fails today because the kind is unknown and curated append returns early.

Name-only on an unknown id with explicit type, `DetectOcrModelFromFileList({}, "future-doc-vlm-pack", "doc_vlm")`: pack rows miss, family rows supply the same four hints. This fails until `ocr.doc_vlm` is regenerated.

`OcrRowsForModelType("doctr")` and `OcrRowsForModelType("ppocr")` stay non-empty.

### 10.4  Jest `src/model-languages/ocr/__tests__/hints.test.ts`

Replace the “no family fallback” expectation:

- `iso6391HintsForOcrModelType('doc_vlm')` equals `['en', 'ja', 'ar', 'zh']`
- `iso6391HintsForOcrModelType('doc_vlm', 'docvlm-granite-258m')` still equals that pack array (pack-first; same values today)
- `DOC_VLM_ISO6391_HINTS` equals that array
- `iso6391HintsForOcrModelType('doctr')` and `iso6391HintsForOcrModelType('ppocr')` unchanged
- `iso6391HintsForOcrModelType('auto')` still returns the ppocr hints

`publicLanguageHintsFromNative` with `modelType: 'doc_vlm'` and four raw rows returns those rows. Same shape as the existing doctr case.

### 10.5  Jest `src/download/__tests__/catalogHints.test.ts`

In `buildCatalogHintsMap — OCR`, add a case whose mock returns `modelType: 'doc_vlm'` and `languages: ['en', 'ja', 'ar', 'zh']` for asset `docvlm-granite-258m`. Assert the hint map and that `detectModelsBatch` was called with `{ assetName: 'docvlm-granite-258m' }`.

### 10.6  Jest `github-asset-rules.test.ts`

```ts
expect(
  isAssetSupportedForCategory(
    ModelCategory.Ocr,
    'docvlm-granite-258m.tar.bz2',
    'tar.bz2'
  )
).toBe(true);
```

Inside the existing OCR describe. Keep the `det.onnx` rejection.

### 10.7  Commands

```bash
yarn generate:model-language-catalog
yarn jest --testPathPattern 'hints|catalogHints|github-asset-rules|ocr/__tests__/offline-api' --no-coverage
ctest -R 'model_detect_test|curated_language_catalog_test' --output-on-failure
```

`offline-api` is a regression run: the mocked doc_vlm detect tests from Phase 3 must stay green. `doc_vlm_host_test` is not a Phase 4 gate (it loads the backend and skips without the unpacked pack).

---

## 11  File-by-file

### 11.1  Edit

| File | Change |
| --- | --- |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h` | `OcrModelKind::kDocVlm`. Eight fields on `OcrModelPaths`. Update the enum comment that currently names only ppocr and doctr. |
| `android/src/main/cpp/jni/model_detect/ocr/sherpa-onnx-model-detect-ocr.cpp` | Aliases in `ParseOcrModelTypeStrict` and `OcrKindToTag`. `InferDocVlmNameOnly` before doctr. `CanDocVlmLayout`. Manifest `family` helper. Auto priority §2. Path assignment for `kDocVlm` only. Unrecognized-layout error text. |
| `android/src/main/cpp/jni/model_detect/ocr/sherpa-onnx-validate-ocr.cpp` | `kDocVlmReqs`. Arms in `GetRequirements` and `OcrKindToName`. |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-validate-custom.cpp` | `ParseOcrModelTypeLocal` aliases. The `"ocr"` branch already calls `FillOcrModelPathsFromStringMap` + `ValidateOcrPaths` / `GetOcrPathRequirements`. |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-path-fill.cpp` | `FillOcrModelPathsFromStringMap` and `OcrModelPathsToStringMap` for the eight keys. `manifest` stays. |
| `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect-unified.cpp` | `OcrModelKindToString`. STT override only if the §5.1 test fails. |
| `android/src/main/cpp/jni/model_detect/common/model_language_catalog.cpp` | `OcrKindToModelType` and `InferOcrModelTypeFromKey`. |
| `android/src/main/cpp/ocr/OcrDetect.h` | Eight path strings. |
| `android/src/main/cpp/ocr/OcrDetect.cpp` | `KindToFamily` + copies. |
| `android/src/main/cpp/jni/ocr/sherpa-onnx-ocr-jni.cpp` | `nativeDetect` puts the eight keys on `paths` and `files`. |
| `ios/ocr/bridge/SherpaOnnx+OCR.mm` | Same. |
| `android/src/main/java/com/sherpaonnx/ocr/facade/SherpaOnnxOcrHelper.kt` | `detectMapToWritable` copies the eight keys onto `paths` and `files`. |
| `src/NativeSherpaOnnx.ts` | Optional eight keys on `OcrDetectNativeResult.files`. |
| `catalog/model-language-catalog.json` | `ocr.doc_vlm.hints`. |
| `scripts/generate-model-language-catalog.mjs` | Validate `ocr.doc_vlm.hints`. Emit loop stays generic. |
| `src/model-languages/ocr/index.ts` | Re-export `DOC_VLM_ISO6391_HINTS`. |
| `src/model-languages/generated/catalog.ts` | Regenerated. |
| `android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h` | Regenerated. `OcrRowsForModelType("doc_vlm")` gains four rows. Pack map for `docvlm-granite-258m` stays. |
| `test/cpp/model_detect/model_detect_test_utils.cpp` | Kind string mapping. |
| `test/cpp/model_detect/model_detect_test.cpp` | Fixture branch + §10.2 cases. |
| `test/cpp/model_detect/curated_language_catalog_test.cpp` | §10.3. |
| `src/model-languages/ocr/__tests__/hints.test.ts` | Family fallback is the four hints. |
| `src/download/__tests__/catalogHints.test.ts` | Granite asset case. |
| `src/download/sources/__tests__/github-asset-rules.test.ts` | `docvlm-granite-258m.tar.bz2`. |

### 11.2  Leave unchanged

| File | Why |
| --- | --- |
| `android/src/main/cpp/ocr/OcrFactory.cpp` | Phase 3 already constructs `DocVlmBackend` for `doc_vlm` and the aliases. `"auto"` stays ppocr at the factory. |
| `android/src/main/cpp/ocr/OcrEngine.cpp` | `Load("auto")` already uses `detect.modelType`. |
| `android/src/main/cpp/ocr/doc_vlm/*` | Backend and strict manifest loader stay. Detect uses its own family scan. |
| `src/ocr/types.ts`, `src/ocr/index.ts` | Guard, aliases at the TS init boundary, and path completeness are Phase 3. |
| `src/types/modelDetect.ts` | `OcrDocVlmSuccessPaths` is already the eight keys. |
| `scripts/ocr-models/sources.csv` | Pack row and `en,ja,ar,zh` are already there. |
| `test/fixtures/ocr-models-structure.txt`, `ocr-models-expected.csv` | Granite block and expected type are already there. |
| `src/download/paths.ts`, `github-xdcobra.ts`, `github-asset-rules.ts`, `catalogDetectCategories.ts` | OCR `tar.bz2` on tag `ocr-models` already lists this asset once the filter test names it. |
| `docs/ocr-offline.md`, `docs/model-languages.md`, `docs/feature-pipelines.md`, README | Phase 5. |
| Example app / VoiceLab | Out of the epic. |
| `DetectionSource` | No new enumerator. Manifest selection is still `kFileListing`. |

Every `switch` on `OcrModelKind` listed in §11.1 needs a `kDocVlm` arm. A missing arm that falls through `default` returns `"unknown"` or an empty requirement list and drops the family out of unified detect or validate.

---

## 12  Implementation order

1. Enum, `OcrModelPaths` fields, `kDocVlmReqs`, both alias parsers (`ParseOcrModelTypeStrict`, `ParseOcrModelTypeLocal`).
2. `CanDocVlmLayout`, name-only predicate, manifest `family` scan, auto priority, path assignment, path-fill maps, `OcrModelKindToString`, catalog kind strings.
3. `ocr::DetectOcrModel` plus JNI, iOS, and Kotlin copies. `files` type in `NativeSherpaOnnx.ts`.
4. `catalog.json` `ocr.doc_vlm.hints`, generator validation, `yarn generate:model-language-catalog`, re-export.
5. C++ detect tests, including the unified temp-directory test. Add the STT override only if that test returns a non-OCR hit.
6. Curated-language tests, Jest hints, catalogHints, asset-rules.
7. Run the commands in §10.7.

One commit is enough when the user asks for it: detect + catalog regeneration + tests. Do not commit the 1.2 GiB archive.

---

## 13  Acceptance

- [ ] `OcrModelKind::kDocVlm` exists. `OcrModelKindToString`, `OcrKindToTag`, `KindToFamily`, and `OcrKindToModelType` all return `"doc_vlm"`.
- [ ] Aliases `docvlm`, `doc-vlm`, `granite-docling`, `docling` select `kDocVlm` in detect and in `ParseOcrModelTypeLocal`. `doctr-mobile` and `doc-tr` still select `kDoctr`.
- [ ] `CanDocVlmLayout` is true only when all eight basenames are present. Missing `decoder_model_merged.onnx_data` or substituting `tokenizer_config.json` for `tokenizer.json` is a failure.
- [ ] `GetOcrPathRequirements(kDocVlm)` is those eight keys, each required. `ValidateOcrPaths` fails closed when any one is empty.
- [ ] Auto, file on disk, `"family": "doc_vlm"` selects `kDocVlm` even if `det.onnx` and `rec.onnx` are also present.
- [ ] Auto, file on disk, `"family": "doctr"` with a real doctr layout selects `kDoctr`. The same family on a granite-only directory fails and does not fall through.
- [ ] Auto, manifest not on disk, eight basenames present, selects `kDocVlm` with det/rec empty. The fixture row `docvlm-granite-258m.tar.bz2` is no longer skipped and passes.
- [ ] Name-only `docvlm-granite-258m` and `docling` are `kDocVlm`, `ok == false`, and the granite id gets curated languages `en`, `ja`, `ar`, `zh`.
- [ ] Unified detect on a temp directory of those basenames returns category `ocr`, model type `doc_vlm`.
- [ ] JNI, iOS, and Kotlin detect maps emit the eight keys. A JS `detectOcrModel` of a real directory can satisfy `isOcrDocVlmDetectSuccess`.
- [ ] `OcrEngine::Load("auto")` on that directory resolves `modelType` to `doc_vlm` and constructs `DocVlmBackend`. Factory `"auto"` without a prior detect remains ppocr.
- [ ] `catalog.json` has `ocr.doc_vlm.hints` of length 4. `yarn generate:model-language-catalog` succeeds. `DOC_VLM_ISO6391_HINTS` is exported. `iso6391HintsForOcrModelType('doc_vlm')` returns the four hints. `iso6391HintsForOcrModelType('auto')` stays on ppocr hints.
- [ ] `OcrRowsForModelType("doc_vlm")` has 4 rows. `OcrPackRowsForModelKey("docvlm-granite-258m")` still has 4 rows.
- [ ] `isAssetSupportedForCategory(Ocr, 'docvlm-granite-258m.tar.bz2', 'tar.bz2')` is true. `gh release view` shows that asset name on tag `ocr-models`.
- [ ] Jest paths in §10.7 and `ctest -R 'model_detect_test|curated_language_catalog_test'` pass.
- [ ] Existing ppocr and doctr detect tests pass, including doctr-without-manifest and ppocr-without-dict.

---

## 14  Not this phase

| Item | Where it belongs |
| --- | --- |
| `docs/ocr-offline.md`, `docs/model-languages.md`, `docs/feature-pipelines.md`, README | Phase 5 |
| CI job that downloads `docvlm-granite-258m` (`test-ocr-host.yml`) | Phase 5 |
| Host golden `DOCVLM_STRICT_GOLDEN` | Phase 5 |
| Jest E2E that calls native `createOCR` + `recognize` on a device | Phase 5 |
| Example app / VoiceLab | Out of the epic |
| Second weight variant, int8 filenames, PDF pages | Later |
| Editing `DocVlmBackend`, recognize extras, or `maxNewTokens` | Phase 2–3, done |
| Rebuilding ONNX Runtime | Not this epic |
| A new `DetectionSource` for “manifest” | Not needed |
| Requiring `ocr.doc_vlm.entries` or a language picker | This pack is one multilingual model |
| Changing whisper / moonshine token rules | Only the §5.1 override, and only if the unified test shows a steal |
