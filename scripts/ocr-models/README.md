# OCR model release assets

This folder contains a CSV-driven pipeline that builds one `.tar.bz2` archive per
OCR pack ID and uploads missing archives to the GitHub release tag `ocr-models`.

Release page (after first publish):
https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/ocr-models

## CSV format

File: `scripts/ocr-models/sources.csv`

- Delimiter: semicolon (`;`)
- Required header (exact):
  `id;family;det_url;rec_url;cls_url;rec_yml_url;det_config_url;rec_config_url;license;license_type;commercial_use;languages`

| Column | Required | Description |
| --- | --- | --- |
| `id` | yes | Directory name inside archive and archive base name (`<id>.tar.bz2`) |
| `family` | yes | `ppocr` or `doctr` — drives archive layout and which URL columns apply |
| `det_url` | yes | Direct URL to detection ONNX → stored as `det.onnx` |
| `rec_url` | yes | Direct URL to recognition ONNX → stored as `rec.onnx` |
| `cls_url` | ppocr | Orientation classifier ONNX → `cls.onnx` (empty for doctr v1) |
| `rec_yml_url` | ppocr | Recognition `inference.yml` → `rec_inference.yml` (must be empty for doctr) |
| `det_config_url` | doctr | OnnxTR det `config.json` (merged into `ocr_manifest.json`) |
| `rec_config_url` | doctr | OnnxTR rec `config.json` (vocab + preprocess → `ocr_manifest.json`) |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE` |
| `license_type` | yes | SPDX-style label (e.g. `apache-2.0`) |
| `commercial_use` | yes | `yes` or `no` |
| `languages` | no | Comma-separated ISO codes for catalog hints. Empty = not curated. |

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

## Host GTests (PpocrBackend / DoctrBackend)

Unpack packs under `build/ocr-models/<id>/` (or set env vars) for host OCR tests.
See `test/cpp/ocr/` and CI collect stream `ocr`.
