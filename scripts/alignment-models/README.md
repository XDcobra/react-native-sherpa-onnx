# alignment model release assets

This folder contains a CSV-driven pipeline that builds one `.tar.bz2` archive per model ID and uploads missing archives to the GitHub release tag `alignment-models`.

Release page:
https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models

## CSV format

File: `scripts/alignment-models/sources.csv`

- Delimiter: semicolon (`;`)
- Required header (exact): `id;onnx_url;license;license_type;commercial_use;tokens_url;vocab_url;languages`

Columns:

| Column | Required | Description |
| --- | --- | --- |
| `id` | yes | Directory name inside archive and archive base name (`<id>.tar.bz2`) |
| `onnx_url` | yes | Direct URL to the ONNX model file (always stored as `model.onnx`) |
| `license` | no | Optional URL for license text; downloaded as `<id>/LICENSE`; also written to `license_file` in `alignment-models-license-status.csv` |
| `license_type` | yes | SPDX-style label (e.g. `apache-2.0`) for app license screens |
| `commercial_use` | yes | `yes` or `no`, same convention as other `*-models-license-status.csv` files |
| `tokens_url` | no | Optional sherpa-style `tokens.txt` URL (unused by current char-CTC packs) |
| `vocab_url` | no | Optional HF `vocab.json` URL (MMS / XLSR / VoxPopuli char CTC, etc.) |
| `languages` | no | Comma-separated ISO 639-1(/639-3) codes for catalog UX hints. Empty = multilingual / not enumerated (e.g. MMS FA). Source of truth for `iso6391HintsForAlignmentModelType` via `yarn generate:model-language-catalog`. |

Example rows:

```text
wav2vec2-base-960h-int8;https://huggingface.co/…/model_int8.onnx;https://huggingface.co/…/apache-2.0.md;apache-2.0;yes;;;en
wav2vec2-xlsr-53-korean-int8;https://huggingface.co/…/model_int8.onnx;https://huggingface.co/…/apache-2.0.md;apache-2.0;yes;;https://huggingface.co/…/vocab.json;ko
mms-300m-1130-forced-aligner-int8;https://huggingface.co/…/model_int8.onnx;https://huggingface.co/…/legalcode.txt;cc-by-nc-4.0;no;;https://huggingface.co/…/vocab.json;
```

The live catalog is `sources.csv` (which models get packed/uploaded). Only char-CTC wav2vec2-family packs belong here. Other runtimes (e.g. mel/GRU `tiny-aligner`) stay out of this release. Omnilingual ASR-CTC is an STT model (sherpa-onnx `omnilingual`), not an alignment pack.

Runtime design (vocab profile + romanization): [`docs/migration/alignment/vocab-profile-and-romanization.md`](../../docs/migration/alignment/vocab-profile-and-romanization.md).

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
  model.onnx      # always (source may be model.int8.onnx etc.)
  tokens.txt      # only if tokens_url is non-empty
  vocab.json      # only if vocab_url is non-empty
  LICENSE         # only if license column is non-empty
```

## Exporting a new HF ONNX pack (optional)

When a commercial wav2vec2 CTC checkpoint exists on Hugging Face but has no
ONNX export yet, use:

```bash
# venv with torch / transformers / optimum[onnxruntime] / onnxruntime
python scripts/alignment-models/export_hf_onnx_pack.py \
  --model <org>/<pytorch-checkpoint> \
  --language <iso639-1> \
  --out build/alignment-onnx-export/packs/<pack-name>-ONNX
```

That writes an onnx-community-style folder (`onnx/model*.onnx`, `vocab.json`,
`LICENSE`, `README.md`, exporter copy). Upload the folder to Hugging Face, then
add `onnx_url` / `vocab_url` rows to `sources.csv`.

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
- `--only <id>`: Build/upload a single model id (repeatable); checksum still covers the full CSV catalog

## Requirements

- Node.js 18+
- `tar` CLI
- `gh` CLI only for upload mode
- `GITHUB_TOKEN` or `GH_TOKEN` for release lookup/upload and for authenticated GitHub downloads
- `HUGGINGFACE_TOKEN` (optional) for Hugging Face downloads in CI

Existing assets are never overwritten by this script. If an archive name already exists in the release, it is skipped.
