# OCR model release assets

This folder contains a CSV-driven pipeline that builds one `.tar.bz2` archive per
OCR pack ID and uploads missing archives to the GitHub release tag `ocr-models`.

Release page (after first publish):
https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/ocr-models

## CSV format

File: `scripts/ocr-models/sources.csv`

- Delimiter: semicolon (`;`)
- Required header (exact):
  `id;det_url;rec_url;cls_url;rec_yml_url;license;license_type;commercial_use;languages`

| Column | Required | Description |
| --- | --- | --- |
| `id` | yes | Directory name inside archive and archive base name (`<id>.tar.bz2`) |
| `det_url` | yes | Direct URL to detection ONNX (`inference.onnx` on HF) → stored as `det.onnx` |
| `rec_url` | yes | Direct URL to recognition ONNX → stored as `rec.onnx` |
| `cls_url` | yes | Direct URL to textline orientation classifier ONNX → stored as `cls.onnx` |
| `rec_yml_url` | yes | Direct URL to recognition `inference.yml` (char dict / meta) → `rec_inference.yml` |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE` |
| `license_type` | yes | SPDX-style label (e.g. `apache-2.0`) |
| `commercial_use` | yes | `yes` or `no` |
| `languages` | no | Comma-separated ISO codes for catalog hints. Empty = multilingual pack |

## Archive layout (detect contract)

Each generated archive contains exactly one model directory:

```text
<id>/
  det.onnx
  rec.onnx
  cls.onnx
  rec_inference.yml
  LICENSE             # only if license column is non-empty
```

v1 packs (`ppocrv6-small`, `ppocrv6-tiny`) are Apache-2.0 full packs (det + rec +
shared textline orientation cls). Empty `languages` means multilingual PP-OCRv6
coverage (zh / Latin / ja for small; tiny drops Japanese — see PaddleOCR docs).

v5 per-script recognizer packs are out of scope for this initial catalog.

### `checksum.txt`

After each non–dry-run publish, the script refreshes release asset **`checksum.txt`**:
one line per `<id>.tar.bz2`, **tab** between filename and **SHA-256** (hex).

### OCR license CSV sync (CI)

The workflow **Publish OCR model assets** runs `sync_ocr_license_status.js`
(unless `--dry-run`), which merges rows into:

- `android/src/main/assets/model_licenses/ocr-models-license-status.csv`
- `ios/Resources/model_licenses/ocr-models-license-status.csv`

## Script usage

Build archives only (no release API call, no upload):

```bash
node scripts/ocr-models/build_and_upload.js --dry-run
```

Build a single pack:

```bash
node scripts/ocr-models/build_and_upload.js --dry-run --only ppocrv6-tiny
```

Build and upload missing archives to the default release:

```bash
GITHUB_TOKEN=... node scripts/ocr-models/build_and_upload.js
```

### Download authentication

- **GitHub URLs**: `GITHUB_TOKEN` / `GH_TOKEN` as `Authorization: Bearer …`
- **Hugging Face URLs**: optional `HUGGINGFACE_TOKEN` in CI

Useful flags:

- `--csv <path>`: Override CSV source path
- `--repo <owner/name>`: Override target repository
- `--tag <release-tag>`: Override release tag (default: `ocr-models`)
- `--build-dir <path>` / `--dist-dir <path>`
- `--dry-run`: Build only
- `--only <id>`: Build/upload a single model id (repeatable); checksum still covers the full CSV catalog

## Requirements

- Node.js 18+
- `tar` CLI
- `gh` CLI only for upload mode
- `GITHUB_TOKEN` or `GH_TOKEN` for release lookup/upload
- `HUGGINGFACE_TOKEN` (optional) for Hugging Face downloads in CI

Existing assets are never overwritten by this script. If an archive name already
exists in the release, it is skipped.
