# alignment model release assets

This folder contains a CSV-driven pipeline that builds one `.tar.bz2` archive per model ID and uploads missing archives to the GitHub release tag `alignment-models`.

Release page:
https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models

## CSV format

File: `scripts/alignment-models/sources.csv`

- Delimiter: semicolon (`;`)
- Required header (exact): `id;onnx_url;license;license_type;commercial_use`

Columns:

| Column | Required | Description |
| --- | --- | --- |
| `id` | yes | Directory name inside archive and archive base name (`<id>.tar.bz2`) |
| `onnx_url` | yes | Direct URL to the ONNX model file |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE`; also written to `license_file` in `alignment-models-license-status.csv` |
| `license_type` | yes | SPDX-style label (e.g. `apache-2.0`) for app license screens |
| `commercial_use` | yes | `yes` or `no`, same convention as other `*-models-license-status.csv` files |

Example row:

```text
wav2vec2-base-960h-int8;https://huggingface.co/…/model.onnx;https://huggingface.co/…/LICENSE;apache-2.0;yes
```

### `checksum.txt`

After each non–dry-run publish, the script refreshes release asset **`checksum.txt`**: one line per `<id>.tar.bz2`, **tab** between filename and **SHA-256** (hex), same style as [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) release checksums. Existing hashes are reused when archives were not rebuilt; missing hashes are filled from local files or by downloading the asset from the release.

### Alignment license CSV sync (CI)

The workflow **Publish alignment model assets** runs `sync_alignment_license_status.js` (unless `--dry-run`), which merges rows into:

- `android/src/main/assets/model_licenses/alignment-models-license-status.csv`
- `ios/Resources/model_licenses/alignment-models-license-status.csv`

Columns: `asset_name`, `license_type`, `commercial_use`, `confidence` (`high`), `detection_source` (`manual`), `license_file` (from the `license` column). The job commits and pushes when those files change.

## Archive layout

Each generated archive contains exactly one model directory:

```text
<id>/
  model.onnx
  LICENSE     # only if license column is non-empty
```

## Script usage

Build archives only (no release API call, no upload):

```bash
node scripts/alignment-models/build_and_upload.js --dry-run
```

Build and upload missing archives to the default release:

```bash
GITHUB_TOKEN=... node scripts/alignment-models/build_and_upload.js
```

### Download authentication

- **GitHub URLs** (`github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `codeload.github.com`, etc.): if `GITHUB_TOKEN` or `GH_TOKEN` is set, it is sent as `Authorization: Bearer …` on downloads (helps with rate limits and private assets).
- **Hugging Face URLs** (`huggingface.co`, `*.huggingface.co`, `hf.co`): in CI set **`HUGGINGFACE_TOKEN`** for `Authorization: Bearer …` on downloads (recommended for LFS / anonymous limits).

Useful flags:

- `--csv <path>`: Override CSV source path
- `--repo <owner/name>`: Override target repository
- `--tag <release-tag>`: Override release tag (default: `alignment-models`)
- `--build-dir <path>`: Override local build directory (default: `build/alignment-models`)
- `--dist-dir <path>`: Override archive output directory (default: `dist/alignment-models`)
- `--dry-run`: Build only, skip release lookup and uploads

## Requirements

- Node.js 18+
- `tar` CLI
- `gh` CLI only for upload mode
- `GITHUB_TOKEN` or `GH_TOKEN` for release lookup/upload and for authenticated GitHub downloads
- `HUGGINGFACE_TOKEN` (optional) for Hugging Face downloads in CI

Existing assets are never overwritten by this script. If an archive name already exists in the release, it is skipped.
