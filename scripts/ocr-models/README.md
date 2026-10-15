# OCR model release assets

This folder contains a CSV-driven pipeline that builds one `.tar.bz2` archive per
OCR pack ID and uploads missing archives to the GitHub release tag `ocr-models`.

Release page (after first publish):
https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/ocr-models

## CSV format

File: `scripts/ocr-models/sources.csv`

- Delimiter: semicolon (`;`)
- Required header (exact):
  `id;family;det_url;rec_url;cls_url;rec_yml_url;det_config_url;rec_config_url;license;license_type;commercial_use;languages;hf_repo`

| Column | Required | Description |
| --- | --- | --- |
| `id` | yes | Directory name inside archive and archive base name (`<id>.tar.bz2`) |
| `family` | yes | `ppocr`, `doctr`, or `doc_vlm` — drives archive layout and which columns apply |
| `det_url` | ppocr, doctr | Direct URL to detection ONNX → stored as `det.onnx`. Empty for `doc_vlm` |
| `rec_url` | ppocr, doctr | Direct URL to recognition ONNX → stored as `rec.onnx`. Empty for `doc_vlm` |
| `cls_url` | ppocr | Orientation classifier ONNX → `cls.onnx` (empty for doctr and `doc_vlm`) |
| `rec_yml_url` | ppocr | Recognition `inference.yml` → `rec_inference.yml` (must be empty for doctr and `doc_vlm`) |
| `det_config_url` | doctr | OnnxTR det `config.json` (merged into `ocr_manifest.json`). Empty for `doc_vlm` |
| `rec_config_url` | doctr | OnnxTR rec `config.json` (vocab + preprocess → `ocr_manifest.json`). Empty for `doc_vlm` |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE` |
| `license_type` | yes | SPDX-style label (e.g. `apache-2.0`) |
| `commercial_use` | yes | `yes` or `no` |
| `languages` | no | Comma-separated ISO codes for catalog hints. Empty = not curated. |
| `hf_repo` | doc_vlm | Hugging Face `owner/name` (no scheme). The script owns the file list and flattens `onnx/` into the pack root. Must be empty for `ppocr` and `doctr` |

## Archive layouts (detect contract)

### `ppocr`

```text
<id>/
  det.onnx
  rec.onnx
  cls.onnx
  rec_inference.yml
  LICENSE             # only if license column is non-empty
```

Packs: `ppocrv6-medium`, `ppocrv6-small`, `ppocrv6-tiny` (Apache-2.0). Languages follow upstream PP-OCRv6 (~50 named languages; see `sources.csv`).

### `doctr` (OnnxTR)

```text
<id>/
  det.onnx
  rec.onnx
  ocr_manifest.json   # family + arch + mean/std + vocab (from HF config.json)
  LICENSE
```

Packs:

| ID | Det | Rec | Languages (hints) |
| --- | --- | --- | --- |
| `doctr-mobile` | `db_mobilenet_v3_large` | `crnn_mobilenet_v3_small` | `en,fr` |
| `doctr-default` | `db_resnet50` | `parseq` (multilingual-v1) | Latin European set in CSV |

`ocr_manifest.json` is the family discriminator for detect (`family: "doctr"`). Do **not** ship `rec_inference.yml` in doctr packs.

### `doc_vlm` (Granite Docling)

```text
<id>/
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
  ocr_manifest.json   # family: "doc_vlm", schema 1, arch, vision/text, special tokens
  LICENSE
```

No `det.onnx`, `rec.onnx`, `cls.onnx`, or `rec_inference.yml`, and no nested `onnx/` directory. Each `.onnx` graph stays next to its `.onnx_data` file because external-data locations are basenames.

Packs:

| ID | Repo (`hf_repo`) | Weights | Languages (hints) |
| --- | --- | --- | --- |
| `docvlm-granite-258m` | `onnx-community/granite-docling-258M-ONNX` | Unsuffixed fp32 graphs under `onnx/` | `en` plus experimental `ja`, `ar`, `zh` |

`en` is the only non-experimental language on the IBM Granite Docling card. Japanese, Arabic, and Chinese are included because IBM names them as experimental. Uncompressed weights are about 1.18 GiB. The `.tar.bz2` is about 420 MiB. Quantized siblings (`q4`, `q4f16`, `fp16`, `int8`, and the rest) are not in this release.

### `checksum.txt`

After each non–dry-run publish, the script refreshes release asset **`checksum.txt`**:
one line per `<id>.tar.bz2`, **tab** between filename and **SHA-256** (hex).

### OCR license CSV sync (CI)

The workflow **Publish OCR model assets** runs `sync_ocr_license_status.js`
(unless `--dry-run`), which merges rows into:

- `android/src/main/assets/model_licenses/ocr-models-license-status.csv`
- `ios/Resources/model_licenses/ocr-models-license-status.csv`

## Script usage

```bash
node scripts/ocr-models/build_and_upload.js --dry-run
node scripts/ocr-models/build_and_upload.js --dry-run --only doctr-mobile
GITHUB_TOKEN=... node scripts/ocr-models/build_and_upload.js
```

### Download authentication

- **GitHub URLs**: `GITHUB_TOKEN` / `GH_TOKEN` as `Authorization: Bearer …`
- **Hugging Face URLs**: optional `HUGGINGFACE_TOKEN` in CI

Useful flags: `--csv`, `--repo`, `--tag`, `--build-dir` / `--dist-dir`, `--dry-run`, `--only <id>`.

## Requirements

- Node.js 18+
- `bsdtar` or GNU `tar` that can write `.tar.bz2`
- `GITHUB_TOKEN` or `GH_TOKEN` for release lookup/upload
- `HUGGINGFACE_TOKEN` (optional) for Hugging Face downloads in CI

Existing assets are never overwritten by this script. If an archive name already
exists on the release, that id is skipped.

## Host GTests (PpocrBackend / DoctrBackend / DocVlmBackend)

- `ppocr_host_test` and `doctr_host_test` run in `.github/workflows/test-ocr-host.yml` with their packs downloaded.
- `doc_vlm_host_test` unit tests (grid math, DocTags, `Family`, empty extras) run in that same job **without** the granite pack. Tokenizer, prompt, and `DocVlmSmoke.EnHello` skip until `DOCVLM_MODEL_DIR` or `build/ocr-models/docvlm-granite-258m` exists.
- The smoke is not on pull requests. Dispatch the workflow with `run_doc_vlm_golden`, or unpack locally with the `curl` / `tar` already printed by the skip message.
