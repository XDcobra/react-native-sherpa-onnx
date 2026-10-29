# OCR model release assets

Nemotron-3.5-Parse ONNX (FP16 desktop + compact INT8) lives on
`XDcobra/Nemotron-3.5-Parse-ONNX`. Export/quantize tooling:
`scripts/ocr-models/nemotron-parse/`.

PaddleOCR-VL-1.6 ONNX (FP16, VLM-only three graphs) lives on
`XDcobra/PaddleOCR-VL-1.6-ONNX`. Export/quantize tooling:
`scripts/ocr-models/paddleocr-vl/`.

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
| `family` | yes | `ppocr`, `doctr`, `doc_vlm`, `nemotron_parse`, or `paddleocr_vl` — drives archive layout and which columns apply |
| `det_url` | ppocr, doctr | Direct URL to detection ONNX → stored as `det.onnx`. Empty for `doc_vlm` / `nemotron_parse` / `paddleocr_vl` |
| `rec_url` | ppocr, doctr | Direct URL to recognition ONNX → stored as `rec.onnx`. Empty for `doc_vlm` / `nemotron_parse` / `paddleocr_vl` |
| `cls_url` | ppocr | Orientation classifier ONNX → `cls.onnx` (empty for doctr, `doc_vlm`, `nemotron_parse`, `paddleocr_vl`) |
| `rec_yml_url` | ppocr | Recognition `inference.yml` → `rec_inference.yml` (must be empty for doctr, `doc_vlm`, `nemotron_parse`, `paddleocr_vl`) |
| `det_config_url` | doctr | OnnxTR det `config.json` (merged into `ocr_manifest.json`). Empty for `doc_vlm` / `nemotron_parse` / `paddleocr_vl` |
| `rec_config_url` | doctr | OnnxTR rec `config.json` (vocab + preprocess → `ocr_manifest.json`). Empty for `doc_vlm` / `nemotron_parse` / `paddleocr_vl` |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE` |
| `license_type` | yes | SPDX-style label (e.g. `apache-2.0`, `openmdw-1.1`) |
| `commercial_use` | yes | `yes`, `no`, or `conditional` (OpenMDW / copyleft house convention) |
| `languages` | no | Comma-separated ISO codes for catalog hints. Empty = not curated. |
| `hf_repo` | doc_vlm, nemotron_parse, paddleocr_vl | Hugging Face `owner/name` (no scheme). The script owns the file list and flattens one Hub folder into the pack root. Must be empty for `ppocr` and `doctr` |

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

| ID | Repo (`hf_repo`) | Hub files (flattened to canonical names) | Languages (hints) |
| --- | --- | --- | --- |
| `docvlm-granite-258m-fp32` | `onnx-community/granite-docling-258M-ONNX` | Unsuffixed fp32 graphs | `en` plus experimental `ja`, `ar`, `zh` |
| `docvlm-granite-258m-q8` | same | `*_quantized` graphs (technique is q8, not the Hub filename) | same |
| `docvlm-granite-258m-fp16` | same | `*_fp16` graphs | same |
| `docvlm-granite-258m-q4f16` | same | `*_q4f16` graphs | same |

Each archive is self-contained (vision + embed + decoder + tokenizer + manifest). Hub graphs keep suffixed `_data` locations; the packer rewrites them to the eight canonical names via `rewrite_onnx_external_location.py`. Hub `_int8` is not a pack: it has no merged decoder. `en` is the only non-experimental language on the IBM Granite Docling card.

### `nemotron_parse` (Nemotron-3.5-Parse)

Same HF flatten as granite. Hub:
[`XDcobra/Nemotron-3.5-Parse-ONNX`](https://huggingface.co/XDcobra/Nemotron-3.5-Parse-ONNX).
One published folder per archive (`onnx/fp16` or `onnx/int8`). Names are already
canonical, so no external-data rewrite.

```text
<id>/
  patch_embed.onnx
  patch_embed.onnx_data
  pos_embed.npy
  vision_encoder.onnx
  vision_encoder.onnx_data
  embed_tokens.onnx
  embed_tokens.onnx_data
  decoder_model_merged.onnx
  decoder_model_merged.onnx_data
  tokenizer.json
  ocr_manifest.json       # family: "nemotron_parse"
  LICENSE                 # NVIDIA OpenMDW-1.1 (from the CSV license URL)
  TOKENIZER_ATTRIBUTION.md  # optional; tokenizer is MIT
```

| ID | Repo (`hf_repo`) | Hub folder | Languages (hints) |
| --- | --- | --- | --- |
| `nemotron-3.5-parse-fp16` | `XDcobra/Nemotron-3.5-Parse-ONNX` | `onnx/fp16` | MOSCAR → 124 ISO codes (`en` first) |
| `nemotron-3.5-parse-int8` | same | `onnx/int8` (official e5) | same |

Weights: **OpenMDW-1.1**, `commercial_use=conditional` (same house label as Nemotron ASR). Tokenizer is MIT; the NVIDIA `LICENSE` points at `TOKENIZER_ATTRIBUTION.md`. Do not pack Hub `onnx/fp16`+`onnx/int8` as one archive. Q4F16 is not a release pack.

Language hints are NVIDIA MOSCAR coverage (163 language/script entries → unique ISO 639-1 plus `yue`). MOSCAR is synthetic; NVIDIA does not treat it as a real-document guarantee. IndicVisionBench real pages: `bn`, `gu`, `hi`, `kn`, `ml`, `mr`, `or`, `pa`, `ta`, `te`.

CI uses the same **Publish OCR model assets** job as granite (HF download → archive). Set `NEMOTRON_PARSE_EXPORT_ROOT` only to flatten a local export instead of the Hub. Re-export / restage HF with `scripts/ocr-models/nemotron-parse/`.

### `paddleocr_vl` (PaddleOCR-VL)

Same HF flatten as Nemotron. Hub:
[`XDcobra/PaddleOCR-VL-1.6-ONNX`](https://huggingface.co/XDcobra/PaddleOCR-VL-1.6-ONNX).
One published folder per archive (`onnx/fp16`). Names are already canonical
(`vision_encoder` / `embedding` / `decoder`), so no external-data rewrite.

```text
<id>/
  vision_encoder.onnx
  vision_encoder.onnx_data
  embedding.onnx
  embedding.onnx_data
  decoder.onnx
  decoder.onnx_data
  tokenizer.json
  ocr_manifest.json       # family: "paddleocr_vl"
  LICENSE                 # Apache-2.0 (from the CSV license URL)
```

| ID | Repo (`hf_repo`) | Hub folder | Languages (hints) |
| --- | --- | --- | --- |
| `paddleocr-vl-1.6-fp16` | `XDcobra/PaddleOCR-VL-1.6-ONNX` | `onnx/fp16` | Official 109-language Table A1 → unique ISO 639-1 (`en`, `zh` first) |

Weights: **Apache-2.0**, `commercial_use=yes`. Do not pack Hub `onnx/fp16` together
with unpublished INT8 / Q4 folders. INT8 and Q4F16 failed the camera-photo gate
and are not release packs.

Language hints are the PaddleOCR-VL paper Table A1 languages that have an ISO 639-1
code. Script-only / 639-3 names (Adyghe, Bhojpuri, …) are omitted. This is catalog
coverage, not a per-page guarantee.

Set `PADDLEOCR_VL_EXPORT_ROOT` only to flatten a local export instead of the Hub.
Re-export / restage HF with `scripts/ocr-models/paddleocr-vl/`.

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
GITHUB_TOKEN=... node scripts/ocr-models/build_and_upload.js \
  --only nemotron-3.5-parse-fp16 --only nemotron-3.5-parse-int8
```

Workflow **Publish OCR model assets** (`models-publish-ocr.yml`):

- `dry_run` — pack without upload
- One job: `ppocr` / `doctr` / `doc_vlm` / `nemotron_parse` / `paddleocr_vl` (HF downloads)
- Existing release assets are skipped; only missing ids are built
- License CSV sync runs after upload (unless dry-run)

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
- `doc_vlm_host_test` unit tests (grid math, DocTags, `Family`, empty extras) run in that same job **without** the granite pack. Tokenizer, prompt, and `DocVlmSmoke.EnHello` skip until `DOCVLM_MODEL_DIR` or `build/ocr-models/docvlm-granite-258m-fp32` exists.
- The smoke is not on pull requests. Dispatch the workflow with `run_doc_vlm_golden`, or unpack locally with the `curl` / `tar` already printed by the skip message.
