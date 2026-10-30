# Phase 1 — `doc_vlm` packs, publish, license, fixtures

> Branch: `feat/add-ocr-doc-vlm`
> Prereq: doctr pack pipeline on this branch (`family` is `ppocr` | `doctr` only)
> Out of scope: spike, factory, detect, public API, example app (Phases 2–5)

High-level contract: [`.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md`](../../.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md).

Phase 1 publishes one archive, `docvlm-granite-258m.tar.bz2`, on the existing GitHub release tag `ocr-models`. The archive is the source of truth for later detect and `DocVlmBackend`. This phase does not load the model.

---

## 0  Decisions

| Decision | Choice |
| --- | --- |
| Pack id | `docvlm-granite-258m` |
| Family string | `doc_vlm` (manifest, CSV, expected CSV). Aliases stay out of this phase. |
| Weights | Unsuffixed fp32 graphs from `onnx-community/granite-docling-258M-ONNX` `onnx/` (`transformers.js_config.dtype` is `fp32`). Not the q4/fp16/int8 siblings. |
| CSV | Append one column, `hf_repo`. Script owns the file list. Do not overload `det_url` / `rec_url` / config URL columns. |
| License | SPDX `apache-2.0`, `commercial_use=yes`. Same choosealicense Apache text URL as the other OCR rows. |
| Languages | `en,ja,ar,zh` (primary `en` plus the three experimental languages named on the IBM card). |
| Detect | Do not implement `kDocVlm` here. Expected CSV may already say `doc_vlm`; today's host test skips unknown OCR kinds. |
| Flatten `onnx/` | Yes. External-data locations inside the graphs are basenames (`vision_encoder.onnx_data`, not `onnx/vision_encoder.onnx_data`). Pack root must keep each `.onnx` next to its `.onnx_data`. |

---

## 1  What the builder does today

`scripts/ocr-models/build_and_upload.js` is the only pack builder. Exact extension points:

| Location | Today | Phase 1 change |
| --- | --- | --- |
| `EXPECTED_HEADER` (lines 18–31) | 12 columns ending at `languages` | Append `hf_repo` |
| `VALID_FAMILIES` (line 32) | `ppocr`, `doctr` | Add `doc_vlm` |
| `readSources` family error (lines 278–281) | `"ppocr" or "doctr"` | Include `doc_vlm` |
| Global URL requires (lines 283–287) | `det_url` and `rec_url` required for every row | Required only for `ppocr` and `doctr` |
| Family branches (lines 289–319) | `ppocr` requires cls + yml, forbids config URLs; `doctr` forbids yml, requires both config URLs | Add `doc_vlm`: all six URL columns empty; `hf_repo` required |
| Source object (lines 333–346) | No repo field | Add `hfRepo` |
| `buildPpocrPack` / `buildDoctrPack` | Column → fixed filename | Unchanged |
| `buildArchives` dispatch (lines 765–771) | `ppocr` / `doctr` / throw | `doc_vlm` → `buildDocVlmPack` |
| `downloadFile` (lines 410–436) | Buffers the whole body (`arrayBuffer` then `Buffer.from`) | Stream to disk. Required for the 628 MiB decoder external data (two in-memory copies are ~1.3 GiB). |
| License download + `tar -cjf` | After the family builder | Unchanged. `LICENSE` is still optional and driven by the `license` column. |

`sync_ocr_license_status.js` needs no logic change. It already maps every `readSources()` row to `<id>.tar.bz2,license_type,commercial_use,high,manual,<license url>`.

`scripts/generate-model-language-catalog.mjs` already builds pack maps from every OCR source row (`buildOcrPackLanguageMaps`). A new row appears in `OCR_PACK_ISO6391_HINTS_BY_ID` / `OcrPackRowsForModelKey` after regenerate. It does **not** create a family fallback. `catalog/model-language-catalog.json` still only has `ocr.ppocr` and `ocr.doctr`. Leave that for Phase 4.

Workflows already target this pipeline:

- `.github/workflows/models-publish-ocr.yml` — `workflow_dispatch`, default CSV `scripts/ocr-models/sources.csv`, default tag `ocr-models`. Runs `build_and_upload.js`, then `sync_ocr_license_status.js`, then commits the two license CSVs if they changed. No `--only` input. Existing release assets are skipped by name, so a full run only builds ids missing from the tag.
- `.github/workflows/collect-model-structures.yml` — `workflow_dispatch` input `stream=ocr` selects `scripts/ci/sherpa_model_collect_manifest.json` → `scripts/ci/sherpa_ocr_model_release_streams.json` (tag `ocr-models`, fixtures under `test/fixtures/ocr-models-*`, license CSV under `android/.../ocr-models-license-status.csv`).

---

## 2  Hugging Face files to ship

Repo: [onnx-community/granite-docling-258M-ONNX](https://huggingface.co/onnx-community/granite-docling-258M-ONNX).
Resolve base: `https://huggingface.co/onnx-community/granite-docling-258M-ONNX/resolve/main/`.

Sizes are the Hub `tree` API `size` fields (2026-10-15). Graphs were downloaded and checked: they are real ONNX (not Git LFS pointer text), and every external-data `location` is a basename.

### 2.1  ONNX (fp32, required)

| Repo path | Pack path | Bytes | Approx |
| --- | --- | --- | --- |
| `onnx/vision_encoder.onnx` | `vision_encoder.onnx` | 296,983 | 290 KiB |
| `onnx/vision_encoder.onnx_data` | `vision_encoder.onnx_data` | 374,043,648 | 356.7 MiB |
| `onnx/embed_tokens.onnx` | `embed_tokens.onnx` | 434 | 434 B |
| `onnx/embed_tokens.onnx_data` | `embed_tokens.onnx_data` | 231,211,008 | 220.5 MiB |
| `onnx/decoder_model_merged.onnx` | `decoder_model_merged.onnx` | 202,896 | 198 KiB |
| `onnx/decoder_model_merged.onnx_data` | `decoder_model_merged.onnx_data` | 658,121,984 | 627.6 MiB |

ONNX subtotal: **1,263,876,953 bytes (~1.177 GiB)**. `embed_tokens.onnx` records external length `231211008`, matching the data file.

Do not ship the other `onnx/` siblings. Suffix coverage is not uniform, so a variant column would lie:

| Suffix | vision | embed | decoder |
| --- | --- | --- | --- |
| _(fp32, unsuffixed)_ | yes | yes | yes |
| `_fp16` | yes | yes | yes |
| `_q4` | yes | yes | yes |
| `_q4f16` | yes | yes | yes |
| `_quantized` | yes | yes | yes |
| `_int8` | yes | yes | no |
| `_uint8` | yes | yes | no |
| `_bnb4` | yes | no | no |

A later pack such as `docvlm-granite-258m-q4f16` is about **252 MiB** of weights (vision 54.8 MiB + embed 110.3 MiB + decoder 89.1 MiB, plus small graphs). Not this phase.

### 2.2  Tokenizer and processor (required)

Spike (Phase 2) is autoregressive Idefics3 / Granite Docling: GPT-2 BPE tokenizer, chat template, image processor. Ship the Hub files whole. Do not trim `tokenizer.json` or rewrite templates in the builder.

| Repo path | Pack path | Bytes |
| --- | --- | --- |
| `tokenizer.json` | `tokenizer.json` | 4,131,145 |
| `tokenizer_config.json` | `tokenizer_config.json` | 18,616 |
| `vocab.json` | `vocab.json` | 1,612,698 |
| `merges.txt` | `merges.txt` | 916,646 |
| `added_tokens.json` | `added_tokens.json` | 35 |
| `special_tokens_map.json` | `special_tokens_map.json` | 1,078 |
| `chat_template.jinja` | `chat_template.jinja` | 588 |
| `config.json` | `config.json` | 1,819 |
| `generation_config.json` | `generation_config.json` | 174 |
| `preprocessor_config.json` | `preprocessor_config.json` | 486 |
| `processor_config.json` | `processor_config.json` | 68 |

Tokenizer/config subtotal: **~6.6 MiB**.

Leave out `README.md` and `.gitattributes`.

`chat_template.jinja` image part is the literal token `<image>`. The controls branch is a single ASCII space plus `controls | tojson()`, not a `<|controls|>` token. Copy the file bytes; do not "repair" them.

### 2.3  Uncompressed pack and archive

About **1.18 GiB** before `tar.bz2` (weights + tokenizer files + generated manifest + Apache `LICENSE`). External data will barely shrink. Expect an archive around **1.1–1.2 GiB**. GitHub's per-asset limit is 2 GiB, so the upload fits. Host tests and CI collect must download that archive; do not add this id to a job that unpacks every OCR pack on every PR.

---

## 3  Canonical pack layout

```text
docvlm-granite-258m/
  vision_encoder.onnx
  vision_encoder.onnx_data
  embed_tokens.onnx
  embed_tokens.onnx_data
  decoder_model_merged.onnx
  decoder_model_merged.onnx_data
  tokenizer.json
  tokenizer_config.json
  vocab.json
  merges.txt
  added_tokens.json
  special_tokens_map.json
  chat_template.jinja
  config.json
  generation_config.json
  preprocessor_config.json
  processor_config.json
  ocr_manifest.json
  LICENSE
```

No `det.onnx`, `rec.onnx`, `cls.onnx`, `rec_inference.yml`, and no nested `onnx/` directory.

Why this cannot be mistaken for doctr by current detect: `CanDoctrLayout` requires `det.onnx` + `rec.onnx` + `ocr_manifest.json` (`sherpa-onnx-model-detect-ocr.cpp`). Presence of `ocr_manifest.json` alone is not doctr. Current detect does **not** parse the JSON `family` field. Phase 4 must. This pack stays unambiguous only while it has no det/rec filenames.

---

## 4  `ocr_manifest.json` schema

Written by `buildDocVlmPack` after the downloads, from the files on disk (not from hardcoded numeric copies). `family` is the discriminator, same idea as doctr's `"family": "doctr"`.

`config.json` `dtype` is `bfloat16` (training). The ONNX sessions for this pack are the fp32 export. Record both so Phase 2 does not treat the graphs as bf16.

```json
{
  "schema": 1,
  "family": "doc_vlm",
  "id": "docvlm-granite-258m",
  "arch": "idefics3",
  "onnx_dtype": "fp32",
  "source": {
    "repo": "onnx-community/granite-docling-258M-ONNX",
    "subfolder": "onnx",
    "config_dtype": "bfloat16"
  },
  "files": {
    "vision_encoder": "vision_encoder.onnx",
    "vision_encoder_data": "vision_encoder.onnx_data",
    "embed_tokens": "embed_tokens.onnx",
    "embed_tokens_data": "embed_tokens.onnx_data",
    "decoder": "decoder_model_merged.onnx",
    "decoder_data": "decoder_model_merged.onnx_data",
    "tokenizer": "tokenizer.json",
    "tokenizer_config": "tokenizer_config.json",
    "vocab": "vocab.json",
    "merges": "merges.txt",
    "added_tokens": "added_tokens.json",
    "special_tokens_map": "special_tokens_map.json",
    "chat_template": "chat_template.jinja",
    "config": "config.json",
    "generation_config": "generation_config.json",
    "preprocessor_config": "preprocessor_config.json",
    "processor_config": "processor_config.json"
  },
  "vision": {
    "image_size": 512,
    "patch_size": 16,
    "num_channels": 3,
    "scale_factor": 4,
    "image_seq_len": 64,
    "do_image_splitting": true,
    "do_normalize": true,
    "max_image_size_longest_edge": 512,
    "size_longest_edge": 2048,
    "mean": [0.5, 0.5, 0.5],
    "std": [0.5, 0.5, 0.5],
    "rescale_factor": 0.00392156862745098
  },
  "text": {
    "hidden_size": 576,
    "num_hidden_layers": 30,
    "num_attention_heads": 9,
    "num_key_value_heads": 3,
    "head_dim": 64,
    "vocab_size": 100352,
    "max_position_embeddings": 8192,
    "rope_theta": 100000.0,
    "model_type": "llama"
  },
  "special_tokens": {
    "bos_token_id": 100264,
    "eos_token_id": 100257,
    "pad_token_id": 100257,
    "image_token_id": 100270,
    "bos_token": "<|start_of_role|>",
    "eos_token": "<|end_of_text|>",
    "pad_token": "<|end_of_text|>",
    "image_token": "<image>"
  }
}
```

Field sources (fail the build if missing or the wrong type):

| Manifest field | File |
| --- | --- |
| `arch` | `config.json` `model_type` must be `idefics3` |
| `source.config_dtype` | `config.json` `dtype` |
| `vision.image_size`, `patch_size`, `num_channels` | `config.json` `vision_config` |
| `vision.scale_factor` | `config.json` `scale_factor` |
| `vision.image_seq_len` | `processor_config.json` `image_seq_len` |
| `vision.mean`, `std`, `rescale_factor`, splitting / edges | `preprocessor_config.json` |
| `text.*` | `config.json` `text_config` |
| `special_tokens.*_token_id` | `config.json` (`image_token_id` lives on the top-level config, not `generation_config.json`) |
| `special_tokens.image_token` | Must equal `<image>` and must be the `added_tokens_decoder["100270"].content` string in `tokenizer_config.json` |
| `special_tokens.bos_token` / `eos_token` | `special_tokens_map.json` content strings; ids must match `100264` / `100257` |

`files.*` values are the pack-relative names above. The builder checks each path exists and is non-empty before writing the manifest.

Do not embed `vocab.json` or `tokenizer.json` inside the manifest. Doctr does that because its vocab is one string in `config.json`. This tokenizer is multi-megabyte.

Pretty-print with `JSON.stringify(manifest, null, 2)` plus a trailing newline, same as `buildDoctrPack`.

### 4.1  Download guards (same function)

After each weight download:

1. Reject a body whose first line is `version https://git-lfs.github.com/spec/v1` (anonymous LFS miss returns a ~130-byte pointer).
2. Minimum sizes for this fp32 pack: `vision_encoder.onnx_data` ≥ 300 MiB, `embed_tokens.onnx_data` ≥ 200 MiB, `decoder_model_merged.onnx_data` ≥ 600 MiB, `tokenizer.json` ≥ 1 MiB.
3. `embed_tokens.onnx` is a real 434-byte graph. Do not apply a multi-megabyte minimum to the `.onnx` graphs.

URL construction:

```text
https://huggingface.co/${hfRepo}/resolve/main/${repoRelativePath}
```

`hfRepo` must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (no scheme, no `.git`). The file table is a constant in `build_and_upload.js` (`repoRelativePath` → pack filename). Phase 1 has one table: fp32 Granite Docling. A second architecture (PaddleOCR-VL) gets its own table later, not a generic pipe-separated URL cell.

---

## 5  CSV strategy

### 5.1  Why one new column

Three options:

| Approach | Why not, or why yes |
| --- | --- |
| Reuse `det_url` / `rec_url` / `cls_url` / config URLs | Those columns are hardcoded to `det.onnx`, `rec.onnx`, `cls.onnx`, and doctr's two `config.json` merges. Six weight files plus eleven processor files do not fit. Empty-vs-required rules would lie. |
| One quoted multi-file cell (`name=url\|name=url`) | Stays one column, but a 1.2 GiB pack becomes an unreadable line, and a swapped URL is a silent wrong weight file. The parser would also need a second syntax. |
| **Append `hf_repo`** | Existing rows stay valid: `readSources` already pads short rows. ppocr/doctr keep today's URL rules and must leave `hf_repo` empty. The script, not the spreadsheet, assigns canonical filenames. Same split doctr already uses (CSV picks the source, code picks archive names). |

Rejected for this phase: an `onnx_variant` column. Only fp32 is published, and several suffixes do not exist for all three graphs.

### 5.2  Header

```text
id;family;det_url;rec_url;cls_url;rec_yml_url;det_config_url;rec_config_url;license;license_type;commercial_use;languages;hf_repo
```

`doc_vlm` validation:

- `det_url`, `rec_url`, `cls_url`, `rec_yml_url`, `det_config_url`, `rec_config_url` are empty.
- `hf_repo` is set.
- `license_type` and `commercial_use` stay required for every family.
- `languages` stays the existing comma-separated ISO check (`parseLanguagesCell`).

`ppocr` / `doctr`: if `hf_repo` is non-empty, fail the row.

### 5.3  Row to add

Six empty URL fields sit between `doc_vlm` and the license URL (`;;;;;;`).

```text
docvlm-granite-258m;doc_vlm;;;;;;https://huggingface.co/datasets/choosealicense/licenses/resolve/main/markdown/apache-2.0.md;apache-2.0;yes;en,ja,ar,zh;onnx-community/granite-docling-258M-ONNX
```

Column check: id, family, six empty URL columns, license URL, `apache-2.0`, `yes`, `en,ja,ar,zh`, `onnx-community/granite-docling-258M-ONNX`.

### 5.4  Languages

IBM card and YAML (`ibm-granite/granite-docling-258M`):

- Front matter `language: en`
- Summary line: "Language(s): English (NLP)"
- Feature bullet: "Japanese, Arabic and Chinese support (experimental)"

Curate `en,ja,ar,zh`. Do not copy the ppocr ~50-code list or the doctr Latin set. Those are different models.

`en` is the only non-experimental claim. `ja`, `ar`, and `zh` are included because IBM names them. The catalog generator does not know "experimental"; the README row should say so in prose.

Phase 1 does **not** add `ocr.doc_vlm` to `catalog/model-language-catalog.json`. Pack-first lookup (`iso6391HintsForOcrModelType` with a model key, and `OcrPackRowsForModelKey`) works from `sources.csv` alone. Family fallback for `'doc_vlm'` stays absent until Phase 4. Add one Jest case that the pack key returns `['en','ja','ar','zh']` and that `iso6391HintsForOcrModelType('doc_vlm')` with no key is still undefined.

---

## 6  License

| Source | What it says |
| --- | --- |
| `ibm-granite/granite-docling-258M` YAML and model card | `license: apache-2.0`. Commercial use is allowed. This checkpoint is not under the IBM Granite Community License used by some other Granite models. |
| `onnx-community/granite-docling-258M-ONNX` README front matter | `license: apache-2.0`, `base_model: ibm-granite/granite-docling-258M` |
| "Responsible use" section on the IBM card | Usage guidance, not a separate SPDX license. Do not set `commercial_use` to `no` because of it. |

CSV values, matching the other OCR packs:

- `license` = `https://huggingface.co/datasets/choosealicense/licenses/resolve/main/markdown/apache-2.0.md` (downloaded as `<id>/LICENSE`)
- `license_type` = `apache-2.0`
- `commercial_use` = `yes`

`node scripts/ocr-models/sync_ocr_license_status.js` rewrites both:

- `android/src/main/assets/model_licenses/ocr-models-license-status.csv`
- `ios/Resources/model_licenses/ocr-models-license-status.csv`

New row (sorted by asset name, so it lands first):

```text
docvlm-granite-258m.tar.bz2,apache-2.0,yes,high,manual,https://huggingface.co/datasets/choosealicense/licenses/resolve/main/markdown/apache-2.0.md
```

`detection_source=manual` matters. `scripts/ci/update_model_license_csv.sh` does not overwrite manual rows. Collect may run afterward without clobbering this line.

The Hub repo has no `LICENSE` file in the root tree. The choosealicense URL is the archive's license text, consistent with ppocr and doctr.

---

## 7  File-by-file changes

### Edit

| File | Change |
| --- | --- |
| `scripts/ocr-models/sources.csv` | New header column and the row in §5.3. Existing five rows unchanged (no trailing `hf_repo` cell required; the parser pads). |
| `scripts/ocr-models/build_and_upload.js` | Header, family set, validation, `buildDocVlmPack`, dispatch, streaming `downloadFile`, LFS and size guards. ppocr/doctr builders stay as they are. |
| `scripts/ocr-models/README.md` | Document `hf_repo`, the `doc_vlm` layout, the Granite row, approximate archive size, and that quantized variants are not in this release. |
| `android/src/main/assets/model_licenses/ocr-models-license-status.csv` | Via the sync script, not by hand. |
| `ios/Resources/model_licenses/ocr-models-license-status.csv` | Same bytes as the Android file. |
| `src/model-languages/generated/catalog.ts` | Via `yarn generate:model-language-catalog` after the CSV parses. Pack map gains `docvlm-granite-258m`. |
| `android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h` | Same regenerate. `OcrPackRowsForModelKey("docvlm-granite-258m")` returns en/ja/ar/zh. |
| `src/model-languages/ocr/__tests__/hints.test.ts` | One case: pack id `docvlm-granite-258m` → `['en','ja','ar','zh']`. Do not add a `doc_vlm` family-fallback case that expects hints; that fallback does not exist yet. |

### Do not edit in this phase

| File | Why it waits |
| --- | --- |
| `catalog/model-language-catalog.json` | `ocr.doc_vlm` family hints are Phase 4. Generator validation only requires `ocr.ppocr` and `ocr.doctr`. |
| `android/src/main/cpp/jni/model_detect/ocr/*` | No `kDocVlm`, no manifest JSON parse, no aliases (`docvlm`, `doc-vlm`, `granite-docling`, `docling`). |
| `android/src/main/cpp/ocr/**` | No `DocVlmBackend`, no factory branch. |
| `src/ocr/**` | No `modelType: 'doc_vlm'`, no `docVlm` options, no recognize extras. |
| `test/cpp/ocr/*` | No host GTest that runs ORT on this pack. |
| `docs/ocr-offline.md`, `docs/model-languages.md`, `docs/feature-pipelines.md` | Phase 5, except the pack README in this phase. |
| `.github/workflows/models-publish-ocr.yml` | Already correct. Do not add a `doc_vlm`-only job. |
| `.github/workflows/collect-model-structures.yml` | `stream=ocr` already exists. |
| `scripts/ci/sherpa_ocr_model_release_streams.json` | Paths already point at the OCR fixtures and license CSV. |

`test/fixtures/ocr-models-expected.csv` and `test/fixtures/ocr-models-structure.txt` change only after publish, in the collect step (§8). Do not hand-author the structure listing.

---

## 8  Publish and collect

Order is strict. The publish workflow checks out the ref you dispatch. Collect lists whatever is already on the `ocr-models` tag. `build_and_upload.js` never overwrites an existing asset name.

### 8.1  Local checks before dispatch

From the repo root, on `feat/add-ocr-doc-vlm`, after the script and CSV changes:

```bash
node scripts/ocr-models/build_and_upload.js --dry-run --only docvlm-granite-258m
```

Needs network. Set `HUGGINGFACE_TOKEN` if the Hub returns 401/429. Disk: unpacked tree plus archive, plan on ~2.5 GiB free under `build/ocr-models` and `dist/ocr-models`.

Then:

```bash
tar -tjf dist/ocr-models/docvlm-granite-258m.tar.bz2
python3 -c 'import json,tarfile; t=tarfile.open("dist/ocr-models/docvlm-granite-258m.tar.bz2"); m=json.load(t.extractfile("docvlm-granite-258m/ocr_manifest.json")); assert m["family"]=="doc_vlm" and m["schema"]==1 and m["special_tokens"]["image_token"]=="<image>"'
node scripts/ocr-models/sync_ocr_license_status.js
yarn generate:model-language-catalog
```

Commit the CSV, builder, README, both license CSVs, generated catalog files, and the hints test. Do not commit `build/` or `dist/`.

### 8.2  Publish

Push the branch, then:

```bash
gh workflow run models-publish-ocr.yml --ref feat/add-ocr-doc-vlm
gh run watch
```

The workflow uses `secrets.GITHUB_TOKEN` and optional `secrets.HUGGINGFACE_TOKEN`. Dry-run input exists (`dry_run=true`) but the local `--dry-run` above is the one to use first; a CI dry-run still downloads ~1.2 GiB and does not upload.

Expect log lines:

- `[skip]` for `ppocrv6-medium.tar.bz2`, `ppocrv6-small.tar.bz2`, `ppocrv6-tiny.tar.bz2`, `doctr-mobile.tar.bz2`, `doctr-default.tar.bz2`
- `[upload] docvlm-granite-258m.tar.bz2`
- `[upload] checksum.txt` (the release asset is rewritten with `--clobber`; it is not a git file)

If the license CSVs in the commit already match `sources.csv`, the follow-up step prints `No license CSV changes to commit`.

Confirm:

```bash
gh release view ocr-models --repo XDcobra/react-native-sherpa-onnx \
  --json assets --jq '.assets[].name' | sort
```

`docvlm-granite-258m.tar.bz2` and `checksum.txt` must be present. There is no in-repo checksum file to update.

### 8.3  Expected CSV, then collect

`scripts/ci/collect_one_sherpa_release_stream.sh` rebuilds `ocr-models-expected.csv` from the **release asset list**. For each asset it keeps an existing `asset_name,model_type` line. A new asset with no prior line is written as `docvlm-granite-258m.tar.bz2,` (empty type).

`DetectOcrFromFileListMatchesExpected` (`test/cpp/model_detect/model_detect_test.cpp`) maps types through `OcrKindFromString`. `doc_vlm` is not `ppocr` or `doctr`, so it returns `kUnknown` and the loop `continue`s. An empty type does the same. Either way the current test stays green and does not prove the new layout.

Seed the type **after** the asset exists and **before** collect, so the collect commit preserves it:

```text
docvlm-granite-258m.tar.bz2,doc_vlm
```

Keep the file sorted the way collect will rewrite it (asset name order; `docvlm-granite-258m` sorts before `doctr-default`). Commit and push that one-line fixture change, then:

```bash
gh workflow run collect-model-structures.yml --ref feat/add-ocr-doc-vlm -f stream=ocr -f asset_limit=0
gh run watch
```

Do not dispatch `stream=all`. That collects every model family. `stream=ocr` is the only job required. Timeout is 360 minutes; the new cost is downloading one ~1.2 GiB archive and running `tar -tjf`.

Collect commits on the branch (`contents: write`) with message:

```text
chore(testdata): update OCR model structures, expected CSV, and license status from ocr-models release
```

Review that commit:

- `test/fixtures/ocr-models-structure.txt` has a `# Asset: docvlm-granite-258m.tar.bz2` block whose paths match §3 (order follows tar, not this doc).
- `test/fixtures/ocr-models-expected.csv` still says `docvlm-granite-258m.tar.bz2,doc_vlm`, not a trailing comma.
- License CSVs still show `detection_source` `manual`. If collect added a duplicate or an `exhausted` row, stop and fix before merging. Manual rows should be skipped.

If collect runs before the expected-type seed, fix the empty type in a follow-up commit. Do not re-publish the archive to fix fixtures.

### 8.4  What "downloadable" means after Phase 1

`ModelCategory.Ocr` already uses tag `ocr-models` and accepts `.tar.bz2`. The new asset can be fetched by that category with no download-code change. Catalog hints will not label it `modelType: 'doc_vlm'` until Phase 4 detect exists. Do not add a name-only heuristic (`docvlm` in the filename) in this phase.

---

## 9  Acceptance checklist

- [ ] `sources.csv` header is the 13-column line in §5.2. Existing five data rows still build under `--dry-run` validation (no need to re-download them if you only pass `--only docvlm-granite-258m` for the archive; `readSources` still parses the full file).
- [ ] A ppocr or doctr row with `hf_repo` set fails. A `doc_vlm` row with any det/rec/cls/yml/config URL set fails. A `doc_vlm` row with an empty `hf_repo` fails.
- [ ] Dry-run archive member set equals §3.
- [ ] Manifest `family` is `doc_vlm`, `schema` is `1`, `arch` is `idefics3`, `onnx_dtype` is `fp32`, `image_token_id` is `100270`, `image_token` is `<image>`.
- [ ] Each `*.onnx_data` in the archive is at least the minimum in §4.1 (not an LFS pointer).
- [ ] `vision_encoder.onnx` external-data locations are the basename `vision_encoder.onnx_data` (already true upstream; flattening did not require a rewrite).
- [ ] Both license CSVs contain the manual `apache-2.0` / `yes` row for `docvlm-granite-258m.tar.bz2`.
- [ ] `yarn generate:model-language-catalog` succeeds. Pack hints for `docvlm-granite-258m` are `en,ja,ar,zh`. `ocr.doc_vlm` is still absent from `catalog.json`.
- [ ] Hints Jest covers the new pack id.
- [ ] Release tag `ocr-models` has `docvlm-granite-258m.tar.bz2`. Previous five archives were not replaced (`[skip]` in the log).
- [ ] `checksum.txt` on that release includes the new archive name and a 64-char SHA-256.
- [ ] After collect: structure fixture lists the §3 names; expected CSV type is `doc_vlm`.
- [ ] `DetectOcrFromFileListMatchesExpected` still passes because `doc_vlm` is `kUnknown` and is skipped. That skip is acceptable for Phase 1 and is not a detect implementation.

---

## 10  What this phase must not do

Leave all of the following for Phase 2+:

- `DocVlmBackend`, ORT session setup, image preprocessing, autoregressive decode, KV cache, DocTags parse, golden tests against Transformers.js.
- Reading or executing `chat_template.jinja` inside the pack builder.
- Public TS/API changes: `OcrModelType`, `docVlm` options, recognize extras (`doctags` / `markdown`).
- C++/TS detect: `OcrModelKind::kDocVlm`, `CanDocVlmLayout`, parsing `family` inside `ocr_manifest.json`, aliases, path fill, success guards.
- `catalog.json` domain `ocr.doc_vlm`, download `catalogHints` for this id, `docs/ocr-offline.md`.
- A second archive (q4, q4f16, fp16, int8, uint8, bnb4, or PaddleOCR-VL).
- Example app / VoiceLab wiring.
- Rewriting ppocr or doctr archive layouts, or renaming `ocr_manifest.json`.
- Hand-editing generated catalog output instead of running `yarn generate:model-language-catalog`.
- Re-uploading an archive that is already on the tag. The script skips existing names; a bad first upload has to be deleted on the release by a person before a corrected archive can be published under the same id.
