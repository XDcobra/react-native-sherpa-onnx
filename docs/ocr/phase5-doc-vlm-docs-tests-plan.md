# Phase 5 — `doc_vlm` documentation parity + test coverage gaps

> **Status**: Plan (do not implement from this file)
> **Branch**: `feat/add-ocr-doc-vlm`
> **Depends on**: Phases 1–4 (pack `docvlm-granite-258m` on tag `ocr-models`, `DocVlmBackend`, factory + TS API, detect, download, `ocr.doc_vlm` hints, host tests, Jest tests)
> **Explicitly out of scope**: Example App, VoiceLab consumer changes
> High-level contract: [`.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md`](../../.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md)

Phases 1–4 are in the tree. This phase updates the user-facing docs to the three-family API, including the `recognize` return value and the Microsoft contrib-op requirement, and closes the Jest / host gaps that are still open. It does not change recognize, DocTags, detect, or the pack.

---

## 0 · Decisions

| Decision | Choice |
| --- | --- |
| `docs/ocr-offline.md` | Full parity: family line, models, packs, detect, `createOCR`, types, see-also. Also rewrite the `recognize` signature (it is still documented as `Promise<void>`). |
| Language picker | **Do not** add `getDocVlmLanguages()`. `ocr.doc_vlm` has `hints` only, no `entries`. Phase 4 left it that way on purpose: one multilingual pack, not a per-language picker. Document `DOC_VLM_ISO6391_HINTS` and `iso6391HintsForOcrModelType('doc_vlm')`. |
| `en` vs `ja` / `ar` / `zh` | `en` is the non-experimental language on the IBM card. Japanese, Arabic, and Chinese stay in the hint list and are labeled experimental. |
| PR CI (`test-ocr-host.yml`) | Build and run `doc_vlm_host_test` **without** the pack. Pack-gated tests already `GTEST_SKIP`. Do **not** download `docvlm-granite-258m` on `pull_request` or `push`. |
| Granite golden | `workflow_dispatch` input, default off, separate job. Cache the **420 MiB archive**, not the **~1.2 GiB** tree. Raise the timeout only on that job. |
| Strict golden | Do **not** check in `docvlm_en_hello.json` and do **not** set `DOCVLM_STRICT_GOLDEN` in CI. Phase 2 left this as optional; there is still no recorded oracle. |
| `de_guten_tag` / `zh_nihao` host smokes | Do **not** add them. `zh_nihao` is a 9-image prefill and Chinese is experimental. |
| `getDocVlmLanguages` / catalog `entries` | Out. |
| Example app | Out. |
| New native behavior | Out. Comment fixes in `src/ocr/types.ts` and the host-test header are in scope. |

---

## 1 · Documentation audit

### 1A · `docs/ocr-offline.md` — **major edits**

This is the primary OCR user guide. It documents **ppocr** and **doctr** and still types `recognize` as `Promise<void>`. `doc_vlm` does not appear. The `auto` row is also wrong after Phase 4.

The SDK is unpublished. There is no deprecation shim. Callers that `await` the promise and ignore the value keep working. The guide must show the value.

#### API reshape (all three families)

`OcrEngine.recognize` returns `Promise<OcrRecognizeResult>`:

| Field | Meaning |
| --- | --- |
| `family` | Concrete `OcrBackend::Family()`: `'ppocr' \| 'doctr' \| 'doc_vlm'`. `createOCR({ modelType: 'auto' })` still echoes `'auto'` from `initializeOcr`. This field is the family that actually ran. |
| `spanCount` | Spans written to `textOut` after the granularity filter. |
| `doctags` | Raw DocTags after ASCII lstrip. `""` for ppocr and doctr. For `doc_vlm`, the decoded generation with specials kept (`<doctag>` … `</doctag>`). |
| `markdown` | Lossy markdown from the same DocTags walk. `""` for ppocr and doctr. For `doc_vlm`, empty only when the plain text is empty. |

Plain text and spatial spans stay on the empty `OfflineTextBuffer` (`origin: 'ocr'`). DocTags and markdown are **not** written into that buffer.

Failures still reject (`OCR_CANCELLED`, `OCR_RECOGNIZE_FAILED`, …). A native payload missing `family`, `doctags`, `markdown`, or a finite `spanCount` rejects `OCR_INTERNAL_ERROR`. `""` is a valid extra.

Multi-frame: non-empty `doctags` / `markdown` chunks are joined with one `\n` (`OcrEngine.cpp` `appendField`). That newline does **not** shift span UTF-16 offsets. The newline between non-empty plain-text chunks does.

Default `granularity` is `'line'`. `doc_vlm` emits `line` for body elements and `block` for `title` / `section_header_level_*`. The default filter drops title quads from `textOut`. Their text is still inside the buffer text, `doctags`, and `markdown`. `'block'` keeps titles and drops lines. `'word'` can yield an empty span list while text is still filled.

`docVlm.maxNewTokens` is init-time only. It is not a field of `OcrRecognizeOptions`. Omit or `0` → backend default 8192. A non-integer or a negative value is `OCR_INVALID_ARGUMENT` at `createOCR`, before native load.

Aliases `docvlm`, `doc-vlm`, `granite-docling`, and `docling` are accepted by `createOCR` and rewritten to `'doc_vlm'`. They are **not** members of `OcrModelType`. `isOcrModelType('docling')` is false.

#### GroupQueryAttention (contrib op)

Add a short runtime note next to the `doc_vlm` pack row. Do not turn it into a build guide.

`decoder_model_merged.onnx` (opset 21, domain `com.microsoft`) uses the contrib op `GroupQueryAttention`. The host ONNX Runtime zip this repo uses (1.28.x under `third_party/onnxruntime_prebuilt`) includes it. A mobile ONNX Runtime built without Microsoft contrib ops fails when the decoder `Ort::Session` is created, inside `createOCR`, not on the first generated token. The existing load path surfaces that as `OCR_INTERNAL_ERROR`. There is no `supportsDocVlm` probe and no new error code.

Do not tell readers to rebuild ONNX Runtime. `provider` is the shared createOCR field and is passed to `ApplyOrtProvider` for every family, including `doc_vlm`.

#### Line-level edits

| Line(s) | Current content | Required edit |
| --- | --- | --- |
| L9 | Families: `ppocr` and `doctr`. `modelType: 'auto' \| 'ppocr' \| 'doctr'`. | Add **`doc_vlm`** (Granite Docling: vision encoder + embed + merged decoder + tokenizer + manifest). Union becomes `'auto' \| 'ppocr' \| 'doctr' \| 'doc_vlm'`. |
| L17–85 (ppocr quick start) | `await ocr.recognize(...)` discards the result. | Bind `const page = await ocr.recognize(...)`. One sentence: for ppocr, `page.doctags` and `page.markdown` are `""`; text and spans are on `textOut`. Do not paste a second full buffer example. |
| L87–113 (doctr quick start) | Recognize “as in ppocr”. Note says “both families”. | Change the note to three families. Do not duplicate the buffer boilerplate. |
| After L113 | No granite example. | Add a short third snippet: `detectOcrModel` + `isOcrDocVlmDetectSuccess`, `createOCR({ modelType: 'doc_vlm', docVlm: { maxNewTokens: 512 } })`, then `const page = await ocr.recognize(...)` and log `page.family`, `page.doctags`, `page.markdown`. Model dir: `docvlm-granite-258m`. |
| L140–146 (buffer matrix) | Engine notes list `recognize`, `destroy`. | Add: `recognize` also resolves `OcrRecognizeResult`. Extras are not on the text buffer. |
| L150–158 (models table) | ppocr, doctr, and an `auto` row that says “manifest → doctr; rec_dict → ppocr”. | Add a `doc_vlm` row: the eight paths below. **Rewrite `auto`.** If `ocr_manifest.json` is on disk and has a `"family"` string, that family wins and detect does not fall through. If the family string is unavailable: eight-file layout → `doc_vlm`, then det+rec+dictionary → `ppocr`, then det+rec+manifest → `doctr`. A doctr manifest stays doctr even if a `vision_encoder.onnx` is dropped beside it. |
| L158 (canonical names) | ppocr and doctr basenames only. | Add the octet: `vision_encoder.onnx`, `vision_encoder.onnx_data`, `embed_tokens.onnx`, `embed_tokens.onnx_data`, `decoder_model_merged.onnx`, `decoder_model_merged.onnx_data`, `tokenizer.json`, `ocr_manifest.json`. The detect key for the decoder file is `decoder`, not the basename. `vision_encoder.onnx.data` (dot before `data`) does not satisfy `vision_encoder_data`. `tokenizer_config.json`, `vocab.json`, `merges.txt`, and `config.json` ship in the pack and are not required paths. |
| L164–177 (pack tables) | ppocr and doctr only. | New subsection **doc_vlm family** with one row: `docvlm-granite-258m.tar.bz2`. Unpacked weights about **1.18 GiB**. Archive about **420 MiB**. Hints: `en`, plus experimental `ja`, `ar`, `zh`. Not the phone default (`ppocrv6-tiny` stays that). A loaded session is on the order of **4 GiB RSS** (weights mmap’d, plus arenas). Quantized siblings are not in this release. |
| L179 | `getPpocrLanguages()` · `getDoctrLanguages()`. | Keep those getters. Add `iso6391HintsForOcrModelType('doc_vlm')` and `DOC_VLM_ISO6391_HINTS`. State that there is no `getDocVlmLanguages()` picker. Per-pack: `iso6391HintsForOcrModelType('doc_vlm', 'docvlm-granite-258m')` returns the same four codes today. |
| L181–205 | Download snippets for ppocr and doctr. | Add a parallel `ensureModel(ModelCategory.Ocr, 'docvlm-granite-258m')` snippet that guards with `isOcrDocVlmDetectSuccess` and passes `modelType: 'doc_vlm'`. |
| L222–238 | Detect examples and narrowing for ppocr and doctr. | Add the granite call. `isOcrDocVlmDetectSuccess(pre)` narrows `paths` to the eight keys. `cls` and `rec_dict` are not part of a `doc_vlm` success. `det` / `rec` stay empty. |
| L248–267 | `createOCR` shows `ppocr` and `doctr` bags. | Add `docVlm: { maxNewTokens?: number }`. Document the discriminated union: `modelType: 'doc_vlm'` allows `docVlm?` only (`ppocr?` and `doctr?` are `never`). `modelType` omitted or `'auto'` may pass all three bags; the backend that loads reads its own. Mention the four aliases in one sentence. |
| L269–288 | Signature `Promise<void>`. Prose says backends emit line spans. | Replace with `Promise<OcrRecognizeResult>` and the field table from the reshape section. Correct the granularity sentence (line default; `doc_vlm` titles are `block`). |
| L316–339 (pipeline) | Downstream is text buffer, spans, TTS. Mermaid ends at the text buffer. | Keep the mermaid (the buffer path did not change). Add one sentence: `doc_vlm` also returns `doctags` and `markdown` on the promise. |
| L359–386 (types) | Unions stop at doctr. No `OcrRecognizeResult`, no `OcrDocVlmOptions`, no eight-path type. | Extend every union with `'doc_vlm'`. Add rows: `OcrDocVlmOptions` (`maxNewTokens?`), `OcrDocVlmSuccessPaths` (eight keys), `OcrRecognizeResult`, `isOcrDocVlmDetectSuccess`. `OcrInitializeOptions` lists `docVlm?` and is a discriminated union. |
| L381–386 (guards) | ppocr and doctr guards. | Add `isOcrDocVlmDetectSuccess`. |
| L400–416 (errors) | `OCR_INVALID_ARGUMENT` says “invalid frame index”. `OCR_INTERNAL_ERROR` is generic. | `OCR_INVALID_ARGUMENT` also covers a bad `maxNewTokens`. `OCR_INTERNAL_ERROR` also covers a recognize payload missing extras, and a `createOCR` failure when the decoder Session cannot load `GroupQueryAttention`. |
| L421–468 (use cases) | ppocr and doctr `<details>`. | Add a `doc_vlm` `<details>` that reads `page.doctags` / `page.markdown`. Update the shared multi-page snippet so it does not imply a `void` return (assign or explicitly ignore). |
| L513 | See also: `getPpocrLanguages`, `getDoctrLanguages`. | Add `DOC_VLM_ISO6391_HINTS` / `iso6391HintsForOcrModelType('doc_vlm')`. |

**Approach**: Keep one ppocr quick start as the full buffer walkthrough. Doctr and `doc_vlm` stay short, the way the doctr section already is. Put the reshape in the `recognize` section so it is written once. Put pack size, RSS, and `GroupQueryAttention` on the pack row, not in a second guide.

### 1B · `docs/model-languages.md` — **minor edits**

| Line(s) | Current content | Required edit |
| --- | --- | --- |
| L83–84 | Getter table ends at `getDoctrLanguages()`. | Do **not** add a `getDocVlmLanguages()` row. Add a sentence under the table: `doc_vlm` hints are `DOC_VLM_ISO6391_HINTS` (`en`, `ja`, `ar`, `zh`), not a `ModelLanguage[]` picker. |
| L92 | Family fallback “`ppocr` or `doctr`”. | “`ppocr`, `doctr`, or `doc_vlm`”. `auto` and omitted type still fall back to ppocr hints. |
| L94 | Constants list includes `DOCTR_ISO6391_HINTS`. | Add `DOC_VLM_ISO6391_HINTS`. |
| L158–168 | Snippet calls `getPpocrLanguages` and `getDoctrLanguages` and `iso6391HintsForOcrModelType('doctr', 'doctr-mobile')`. | Add `iso6391HintsForOcrModelType('doc_vlm')` and `iso6391HintsForOcrModelType('doc_vlm', 'docvlm-granite-258m')`. Note `en` is the supported language; `ja`, `ar`, `zh` are experimental. |
| L171 | “family list (`ppocr` or `doctr`)”. | Include `doc_vlm`. |
| L192 | See also names the two getters. | Add the `doc_vlm` hint helper. Do not name a getter that does not exist. |

### 1C · `docs/feature-pipelines.md` — **minimal edits**

| Line(s) | Current content | Required edit |
| --- | --- | --- |
| L232–247 | Flowchart plus “Both `ppocr` and `doctr`…”. | “`ppocr`, `doctr`, and `doc_vlm` use the same `createOCR` → `recognize` pipeline. `modelType: 'auto'` resolves from the manifest `family`, then from pack layout. `doc_vlm` also returns `doctags` and `markdown` on the promise; those strings are not stored on the text buffer.” |
| Related docs | `ocr-offline.md` | Leave the links. |

### 1D · `docs/README.md` — **one-line edit**

| Line | Current content | Required edit |
| --- | --- | --- |
| L113 | family `ppocr` · `doctr` | family `ppocr` · `doctr` · `doc_vlm` |

### 1E · `README.md` (root) — **no edit**

L80 is `Offline OCR: [Offline](./docs/ocr-offline.md)`. Families stay an implementation detail of the feature guide, same call as the doctr Phase 5 plan.

### 1F · `scripts/ocr-models/README.md` — **pack section already done**

Verified. No layout rewrite.

| Already present | Leave it |
| --- | --- |
| CSV `family` includes `doc_vlm` | yes |
| URL columns empty for `doc_vlm`; `hf_repo` required | yes |
| Flat octet layout, no nested `onnx/`, no `det.onnx` / `rec.onnx` | yes |
| Pack row `docvlm-granite-258m`, experimental `ja`/`ar`/`zh`, ~1.18 GiB unpacked, ~420 MiB archive, quantized siblings excluded | yes |

**One footer edit** (L140–143). The heading is “Host GTests (PpocrBackend / DoctrBackend)” and the paragraph does not mention `DocVlmBackend`. Replace it with:

- `ppocr_host_test` and `doctr_host_test` run in `.github/workflows/test-ocr-host.yml` with their packs downloaded.
- `doc_vlm_host_test` unit tests (grid math, DocTags, `Family`, empty extras) run in that same job **without** the granite pack. Tokenizer, prompt, and `DocVlmSmoke.EnHello` skip until `DOCVLM_MODEL_DIR` or `build/ocr-models/docvlm-granite-258m` exists.
- The smoke is not on pull requests. Dispatch the workflow with `run_doc_vlm_golden` (see §2C), or unpack locally with the `curl` / `tar` already printed by the skip message.
- Do not add a second dry-run example. `--only doctr-mobile` on L119 is enough to show the flag.

### 1G · Other user guides — **no edits**

| File | Why |
| --- | --- |
| `docs/imagebuffer-offline.md` | OCR is generic. Frames are still the input. |
| `docs/textbuffer-offline.md` | Still accurate: OCR writes plain text and `origin: 'ocr'` spans. Extras are not on this buffer. |
| `docs/model-detect.md` | No OCR family table. |
| `docs/memory-and-models.md` | No OCR pack-size section. The RSS number lives on the pack row in `ocr-offline.md`. |
| `docs/model-setup.md` | No OCR family list. |
| `docs/download-manager.md` | `ModelCategory.Ocr` already covers the tag. No new category. |

### 1H · `THIRD_PARTY_LICENSES/README.md` — **no edits**

No OCR-specific prose. License CSVs already contain the `docvlm-granite-258m.tar.bz2` Apache-2.0 row from Phase 1.

---

## 2 · Test coverage audit — gaps vs ppocr / doctr

### 2A · Host C++ tests (`test/cpp/ocr/`)

| Test file | What already runs without a pack | What needs `docvlm-granite-258m` | Gap |
| --- | --- | --- | --- |
| `ppocr_host_test.cpp` | Factory, including `OcrFactory.DocVlmAndAliasesCreate` | ppocr golden | None for this phase. Factory coverage for `doc_vlm` already rides this binary, which CI builds. |
| `doctr_host_test.cpp` | Doctr units | doctr golden | None. |
| `doc_vlm_host_test.cpp` | `GridMath.*`, `DocTags.*`, `OcrResult.ExtrasDefaultEmpty`, `DocVlmBackend.Family` | `Tokenizer.*`, `Prompt.*` skip without `tokenizer.json`. `DocVlmSmoke.EnHello` skips without the pack. `DocVlmStrict.EnHello` skips unless `DOCVLM_STRICT_GOLDEN=1` **and** `test/fixtures/ocr/expected/docvlm_en_hello.json` exists (it does not). | **The binary is not in CI.** See §2C. Do not add `de` or `zh` smokes. Do not add the strict JSON. |

`doc_vlm_host_test` does not link `OcrFactory.cpp`. Leave that split. CMake `TIMEOUT` stays **300**. The manual job overrides it on the `ctest` command line.

### 2B · Detect and catalog — **already covered**

| Area | Status |
| --- | --- |
| `model_detect_test.cpp` | `kDocVlm`, aliases, eight paths, missing `decoder_data`, name-only `docvlm-granite-258m`, manifest `family` wins |
| `curated_language_catalog_test.cpp` | Pack rows and name-only languages `en`, `ja`, `ar`, `zh` |
| `test/fixtures/ocr-models-expected.csv` | `docvlm-granite-258m.tar.bz2,doc_vlm` |
| `test/fixtures/ocr-models-structure.txt` | Octet listing |

No new detect tests in this phase.

### 2C · CI workflow `.github/workflows/test-ocr-host.yml`

The job `ocr-host` downloads `ppocrv6-tiny` and `doctr-mobile`, builds those two binaries, and runs them. The header comment stops at DoctrBackend. `doc_vlm_host_test` is not built.

#### Why the granite pack stays off the pull-request job

| Fact | Consequence |
| --- | --- |
| Archive ~420 MiB, unpacked weights ~1.18 GiB (decoder external data alone is 628 MiB) | A cache of the extracted tree is a large slice of the 10 GiB Actions cache and is slow to save and restore. |
| Phase 2 RSS budget is about 4 GiB, with 6 GiB free before a smoke | `ubuntu-24.04` (16 GiB RAM) can run one smoke. That is not the blocker. |
| CMake sets `TIMEOUT 300` on `doc_vlm_host_test` | The property covers the whole process. Phase 2 expected the `en_hello` prefill in tens of seconds on a laptop. A cold 4-vCPU runner plus opening the 628 MiB decoder can sit near that cap. A timeout fails the ctest entry. |
| The PR job has no `timeout-minutes` of its own and also gates ppocr and doctr | Putting the smoke in that job means a slow or cached-miss granite run fails the check that ppocr and doctr already pass. |
| `zh_nihao` is a 9-image prefill | Matching doctr’s third golden would multiply wall time. It is not a gate. |

#### Default job (pull_request and push) — do this

In the existing `ocr-host` job, after the doctr ctest step:

1. Add `doc_vlm_host_test` to the `cmake --build … --target` line.
2. Run `ctest --test-dir test/cpp/build -R doc_vlm_host_test --output-on-failure`.
3. Do **not** set `DOCVLM_MODEL_DIR`. Do **not** download or extract the archive. Do **not** add an `actions/cache` entry for it.
4. Expect tokenizer, prompt, smoke, and strict tests to skip. ctest treats skip as success. Grid math, DocTags, empty extras, and `Family` must pass.
5. Leave the CMake timeout at 300. With the pack absent the process returns in seconds.
6. Update the workflow title comment and the job name from “ppocr + doctr” to include `doc_vlm` unit tests (pack not downloaded).

Path filters already include `android/src/main/cpp/ocr/**` and `test/cpp/ocr/**`. No filter change.

#### Manual golden — separate job, default off

Add a `workflow_dispatch` input:

```yaml
workflow_dispatch:
  inputs:
    run_doc_vlm_golden:
      description: Download docvlm-granite-258m and run DocVlmSmoke.EnHello
      type: boolean
      default: false
```

`on.pull_request` and `on.push` stay as they are. Do not give them this input.

New job `doc-vlm-golden`:

| Setting | Value |
| --- | --- |
| `if` | `github.event_name == 'workflow_dispatch' && inputs.run_doc_vlm_golden` |
| `runs-on` | `ubuntu-24.04` (same runner; 16 GiB RAM is enough for one smoke) |
| `timeout-minutes` | `45` (download + bzip2 extract + session load + one decode) |
| Cache | **Archive only**: `dist/ocr-models/docvlm-granite-258m.tar.bz2`. Key `ocr-models-docvlm-granite-258m-archive-v1`. Do not cache `build/ocr-models/docvlm-granite-258m`. |
| Download | On cache miss, `curl` the asset from `…/releases/download/ocr-models/docvlm-granite-258m.tar.bz2`. |
| Extract | Every run, including a cache hit: `tar xjf` into `build/ocr-models`. Check `decoder_model_merged.onnx_data` exists. |
| Env | `DOCVLM_MODEL_DIR=${{ github.workspace }}/build/ocr-models/docvlm-granite-258m`. Do **not** set `DOCVLM_STRICT_GOLDEN`. |
| ctest | `ctest --test-dir test/cpp/build -R doc_vlm_host_test --output-on-failure --timeout 1200` |

`ctest --timeout 1200` overrides the CMake 300s property for that invocation only. Local `ctest -R doc_vlm_host_test` without the flag keeps 300s. Do not edit `test/cpp/CMakeLists.txt` to raise the property.

The job builds only `doc_vlm_host_test`. It does not re-download ppocr or doctr.

If a manual run exceeds 1200s or the runner OOMs, stop and report the wall time from the `[SherpaOnnx:ocr] doc_vlm smoke wall_ms=` line. Do not then move the download onto the pull-request job, and do not add `zh_nihao`.

### 2D · Jest `src/ocr/__tests__/offline-api.test.ts`

Already present (do not re-write):

| Case | Status |
| --- | --- |
| `createOCR` doc_vlm forwards `maxNewTokens` 512, omits the key, forwards `0` | done |
| Aliases `docling` and `docvlm` rewrite to `doc_vlm` | done |
| Negative / non-integer `maxNewTokens` rejects `OCR_INVALID_ARGUMENT` and does not call `initializeOcr` | done |
| ppocr and doctr recognize resolve `doctags: ''`, `markdown: ''` | done |
| doc_vlm recognize returns the mocked doctags and markdown | done |
| Missing extras, missing family, non-finite `spanCount` reject `OCR_INTERNAL_ERROR` | done |
| `isOcrDocVlmDetectSuccess` narrows, rejects other families, rejects a missing `decoder_data` | done |
| `detectOcrModel` mocked success and incomplete pack | done |
| `OCR_MODEL_TYPES` includes `doc_vlm`, length 4, `auto` last | done |

| Gap | What to add |
| --- | --- |
| **2D-1** | One round-trip, matching the doctr test near L372. `createOCR({ modelType: 'doc_vlm', docVlm: { maxNewTokens: 512 } })`, assert `initializeOcr` got `modelType: 'doc_vlm'` and `maxNewTokens: 512`, `recognize` with `granularity: 'line'`, assert the resolved `OcrRecognizeResult` (`family`, `spanCount`, non-empty `doctags` / `markdown` from the mock), then `destroy` calls `unloadOcr`. The pieces exist as separate tests; this locks them as one call sequence. |
| **2D-2** | Twin of the doctr test at L421: `recognize` after `destroy` rejects `OCR_INSTANCE_NOT_FOUND` and does not call `ocrRecognize`. Use `modelType: 'doc_vlm'`. Do not add a third copy for ppocr. |

`onProgress` and `AbortSignal` are shared. No `doc_vlm`-only copies.

Do not point Jest at `build/ocr-models/docvlm-granite-258m`. Do not start ONNX Runtime.

### 2E · Jest `src/model-languages/ocr/__tests__/hints.test.ts`

| Case | Status |
| --- | --- |
| Pack `docvlm-granite-258m` and family `doc_vlm` return `['en','ja','ar','zh']` | done |
| `DOC_VLM_ISO6391_HINTS` equals that array | done |
| `auto` / ppocr / doctr hints unchanged | done |
| `publicLanguageHintsFromNative` with `modelType: 'doc_vlm'` | done |

**No `getDocVlmLanguages()` test**, because the function stays absent. Do not add catalog `entries` to force a getter.

### 2F · Download Jest

| File | Status |
| --- | --- |
| `src/download/__tests__/catalogHints.test.ts` | `docvlm-granite-258m` → `modelType: 'doc_vlm'`, languages `en,ja,ar,zh` | done |
| `src/download/sources/__tests__/github-asset-rules.test.ts` | `docvlm-granite-258m.tar.bz2` accepted for `ModelCategory.Ocr` | done |
| `src/download/sources/__tests__/builtin-github.test.ts` | No OCR `listModels` mock | **Leave it.** The doctr Phase 5 plan marked this nice-to-have and it was never added for ppocr or doctr either. Not a `doc_vlm` gap. |

---

## 3 · Stale comment cleanup

No matches for the literal phrases `ppocr only`, `doctr only`, or `ppocr|doctr only` under `src/ocr`. The leftovers are narrower.

| File | Line | Current text | Fix |
| --- | --- | --- | --- |
| `src/ocr/types.ts` | L73 | `` `auto` once Phase 4 detect can resolve this pack `` | Phase 4 is done. Say `auto` resolves a granite directory through detect. |
| `src/ocr/types.ts` | L133–134 | `v1 PpocrBackend emits line only` | Backends emit `line`. `doc_vlm` also emits `block` for titles. Other granularity values filter spans and may leave the span list empty; text is still filled. |
| `src/ocr/types.ts` | L164 | `Phase 2 §7.2` inside the public `markdown` comment | Keep the rule (empty only when plain text is empty). Drop the phase cross-reference. |
| `src/ocr/index.ts` | L4 | `Backends: ppocr, doctr, doc_vlm.` | Already current. Leave it. |
| `scripts/ocr-models/README.md` | L140 | Host GTests heading names only Ppocr and Doctr | §1F footer. |
| `test/cpp/ocr/doc_vlm_host_test.cpp` | L6 | “this pack is not on the PR workflow” | Keep the skip behavior. Update the sentence so it matches §2C: unit tests run on the PR job without the pack; `DocVlmSmoke.EnHello` runs only when the pack is present (local or `workflow_dispatch`). |

Searched and clean:

| Pattern | Result |
| --- | --- |
| `TODO` / `FIXME` in `src/ocr/` | None |
| `CanDocVlmLayout` in TypeScript | None (native only, and it is real) |
| `OcrFactory.cpp` supported-list string | Already includes `doc_vlm` and the aliases |

---

## 4 · File-by-file change list

### Documentation

| # | File | Action | Effort |
| --- | --- | --- | --- |
| D1 | `docs/ocr-offline.md` | §1A: third family, eight paths, corrected `auto` order, pack row (size, RSS, experimental langs, `GroupQueryAttention`), `recognize` → `OcrRecognizeResult`, types, errors, one short quick start and one `<details>` | High |
| D2 | `docs/model-languages.md` | §1B. No new getter. | Low |
| D3 | `docs/feature-pipelines.md` | One paragraph in the OCR section (§1C). | Trivial |
| D4 | `docs/README.md` | L113 (§1D). | Trivial |
| D5 | `scripts/ocr-models/README.md` | Host-test footer only (§1F). | Trivial |

### Source comments

| # | File | Action | Effort |
| --- | --- | --- | --- |
| S1 | `src/ocr/types.ts` | Three comment fixes (§3). No type changes. | Trivial |
| S2 | `test/cpp/ocr/doc_vlm_host_test.cpp` | Header sentence (§3). No assertion changes. | Trivial |

### Tests and CI

| # | File | Action | Effort |
| --- | --- | --- | --- |
| T1 | `.github/workflows/test-ocr-host.yml` | Build and run `doc_vlm_host_test` on the existing job with no pack. Add `doc-vlm-golden` behind `workflow_dispatch` input `run_doc_vlm_golden` (§2C). | Medium |
| T2 | `src/ocr/__tests__/offline-api.test.ts` | Round-trip (§2D-1) and destroy-then-recognize (§2D-2). | Low |

### Explicitly not in the diff

| File | Why |
| --- | --- |
| `catalog/model-language-catalog.json` | `ocr.doc_vlm.hints` already exists. Do not add `entries`. |
| `src/model-languages/generated/catalog.ts` | No regenerate. |
| `test/cpp/CMakeLists.txt` | Timeout stays 300. Sources already listed. |
| `test/fixtures/ocr/expected/docvlm_en_hello.json` | Do not invent an oracle. |
| `android/src/main/cpp/ocr/**` | Behavior frozen. |
| Example app, `voicelab-app` | Out of scope. |

---

## 5 · Acceptance checklist

### Documentation parity

- [ ] `docs/ocr-offline.md` names `ppocr`, `doctr`, and `doc_vlm` in: the family line, the `modelType` union, the models table, the packs table, a quick-start snippet, a detect example, a `createOCR` example, the types table, and see-also.
- [ ] The `auto` row matches Phase 4: manifest `family` wins; otherwise octet, then ppocr, then doctr.
- [ ] `recognize` is documented as `Promise<OcrRecognizeResult>` with `family`, `spanCount`, `doctags`, `markdown`. The guide says ppocr and doctr resolve the two strings to `""`, and that those strings are not written to the text buffer.
- [ ] `docVlm.maxNewTokens` is documented as init-only (omit or `0` → 8192; bad values → `OCR_INVALID_ARGUMENT`).
- [ ] The pack row states ~420 MiB archive, ~1.18 GiB unpacked, ~4 GiB RSS, `en` plus experimental `ja`/`ar`/`zh`, and that `ppocrv6-tiny` remains the phone default.
- [ ] A reader can see that `decoder_model_merged.onnx` needs `com.microsoft.GroupQueryAttention`, and that a mobile build without that contrib op fails at `createOCR`.
- [ ] `docs/model-languages.md` documents `DOC_VLM_ISO6391_HINTS` and does not document `getDocVlmLanguages()`.
- [ ] `docs/feature-pipelines.md` names all three families and the promise extras.
- [ ] `docs/README.md` OCR row names all three families.
- [ ] `scripts/ocr-models/README.md` pack layout is unchanged; the host-test footer describes the PR skip and the manual smoke.

### Tests and CI

- [ ] The pull-request job builds and runs `doc_vlm_host_test` with no `DOCVLM_MODEL_DIR`. Pack tests skip. Unit tests pass. The job does not download `docvlm-granite-258m`.
- [ ] `workflow_dispatch` input `run_doc_vlm_golden` defaults to false. The golden job caches the `.tar.bz2` only, extracts every run, sets `DOCVLM_MODEL_DIR`, does not set `DOCVLM_STRICT_GOLDEN`, and passes `ctest --timeout 1200`.
- [ ] CMake `TIMEOUT 300` on `doc_vlm_host_test` is unchanged.
- [ ] Jest round-trip covers `doc_vlm` init + recognize result + `destroy`.
- [ ] Jest covers `recognize` after `destroy` for `doc_vlm` (`OCR_INSTANCE_NOT_FOUND`).
- [ ] No new `de_guten_tag` or `zh_nihao` host test. No `docvlm_en_hello.json`.

### Stale comments

- [ ] `src/ocr/types.ts` no longer says “once Phase 4”, “v1 PpocrBackend emits `line` only”, or “Phase 2 §7.2”.
- [ ] `doc_vlm_host_test.cpp` header matches the CI split.

### Final parity audit

- [ ] `rg -n "ppocr|doctr" docs/ocr-offline.md` — each family mention is either three-way, or a ppocr/doctr-specific option that has a `doc_vlm` counterpart elsewhere in the file (`maxNewTokens`, eight paths, extras).
- [ ] `rg -n "Promise<void>" docs/ocr-offline.md` — no `recognize` signature still returns `void`. (`destroy` stays `Promise<void>`.)
- [ ] `rg -n "getDocVlmLanguages" ` returns nothing in `src/` and `docs/`.
- [ ] `rg -n "GroupQueryAttention" docs/ocr-offline.md` hits the runtime note.
- [ ] `yarn test` passes for the OCR Jest files touched.
- [ ] Local, pack absent: `ctest -R doc_vlm_host_test` passes with skips. Local, pack present: `DocVlmSmoke.EnHello` is unchanged and is not required to re-run for this phase unless the golden job is dispatched.

---

## 6 · What NOT to do

1. **No Example App changes** — screens, navigation, and showcase code stay out of the epic.
2. **No VoiceLab changes.**
3. **No native behavior changes** — factory, backend, detect, JNI, and Kotlin are frozen. Comment-only edits are the `types.ts` lines in §3 and the host-test header.
4. **No API surface changes** — do not add `getDocVlmLanguages()`, catalog `entries`, a `supportsDocVlm` probe, a new `OcrErrorCode`, or per-recognize `maxNewTokens`.
5. **No model re-publish** — do not run `build_and_upload.js` for this pack.
6. **No ONNX Runtime rebuild** and no documented GPU success path.
7. **No granite download on pull_request or push**, and no Actions cache of the extracted ~1.2 GiB tree.
8. **No strict-golden JSON** and no `DOCVLM_STRICT_GOLDEN` in CI.
9. **No `zh_nihao` / `de_guten_tag` smoke** added to chase doctr’s third image.
10. **No CMake timeout edit** — the manual job passes `--timeout 1200` instead.
11. **No iOS or Android app-target changes** — host tests only.
12. **No refactor of ppocr or doctr doc sections** beyond the shared `recognize` signature and the `auto` sentence, which are wrong for every family until they are updated.
