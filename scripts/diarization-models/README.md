# diarization model release assets

This folder contains a CSV-driven pipeline that builds one `.tar.bz2` archive per model ID and uploads missing archives to the GitHub release tag `diarization-models`.

Release page:
https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/diarization-models

## CSV format

File: `scripts/diarization-models/sources.csv`

- Delimiter: semicolon (`;`)
- Required header: `id;onnx_url;license;license_type;commercial_use` or `id;onnx_url;license;license_type;commercial_use;metadata`

Columns:

| Column | Required | Description |
| --- | --- | --- |
| `id` | yes | Directory name inside archive and archive base name (`<id>.tar.bz2`) |
| `onnx_url` | yes | Direct URL to the ONNX model file |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE`; also written to `license_file` in `diarization-models-license-status.csv` |
| `license_type` | yes | SPDX/license label (e.g. `nvidia-open-model-license`) for app license screens |
| `commercial_use` | yes | `yes` or `no`, same convention as other `*-models-license-status.csv` files |
| `metadata` | no | Optional URL or relative path to model metadata JSON (e.g. `metadata/<id>.json`); copied as `<id>/metadata.json`. If omitted, automatically checks `scripts/diarization-models/metadata/<id>.json`. |

Example row:

```text
diar_streaming_sortformer_4spk-v2.1;https://huggingface.co/…/diar_streaming_sortformer_4spk-v2.1.onnx;https://huggingface.co/…/LICENSE;nvidia-open-model-license;yes;metadata/diar_streaming_sortformer_4spk-v2.1.json
```

### `checksum.txt`

After each non–dry-run publish, the script refreshes release asset **`checksum.txt`**: one line per `<id>.tar.bz2`, **tab** between filename and **SHA-256** (hex), same style as [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and `alignment-models` release checksums. Existing hashes are reused when archives were not rebuilt; missing hashes are filled from local files or by downloading the asset from the release.

### Diarization license CSV sync (CI)

The workflow **Publish diarization model assets** runs `sync_diarization_license_status.js` (unless `--dry-run`), which merges rows into:

- `android/src/main/assets/model_licenses/diarization-models-license-status.csv`
- `ios/Resources/model_licenses/diarization-models-license-status.csv`

Columns: `asset_name`, `license_type`, `commercial_use`, `confidence` (`high`), `detection_source` (`manual`), `license_file` (from the `license` column). The job commits and pushes when those files change.

## Archive layout

Each generated archive contains exactly one model directory:

```text
<id>/
  model.onnx
  LICENSE        # only if license column is non-empty
  metadata.json  # streaming parameters, chunk sizes, and model contract
```

## Script usage

Build archives only (no release API call, no upload):

```bash
node scripts/diarization-models/build_and_upload.js --dry-run
```

Build and upload missing archives to the default release:

```bash
GITHUB_TOKEN=... node scripts/diarization-models/build_and_upload.js
```

### Download authentication

- **GitHub URLs** (`github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `codeload.github.com`, etc.): if `GITHUB_TOKEN` or `GH_TOKEN` is set, it is sent as `Authorization: Bearer …` on downloads.
- **Hugging Face URLs** (`huggingface.co`, `*.huggingface.co`, `hf.co`): in CI set **`HUGGINGFACE_TOKEN`** for `Authorization: Bearer …` on downloads (recommended for LFS / anonymous rate limits).

Useful flags:

- `--csv <path>`: Override CSV source path
- `--repo <owner/name>`: Override target repository
- `--tag <release-tag>`: Override release tag (default: `diarization-models`)
- `--build-dir <path>`: Override local build directory (default: `build/diarization-models`)
- `--dist-dir <path>`: Override archive output directory (default: `dist/diarization-models`)
- `--dry-run`: Build only, skip release lookup and uploads

## Requirements

- Node.js 18+
- `tar` CLI
- `gh` CLI only for upload mode
- `GITHUB_TOKEN` or `GH_TOKEN` for release lookup/upload and for authenticated GitHub downloads
- `HUGGINGFACE_TOKEN` (optional) for Hugging Face downloads in CI
