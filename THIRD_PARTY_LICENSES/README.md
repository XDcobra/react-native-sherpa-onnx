# Third-party license texts

This directory contains **full license texts** for libraries shipped with this module (e.g. sherpa-onnx, ONNX Runtime, FFmpeg). See the repository [README](../README.md#third-party-libraries) for links.

## Prebuilt model release assets (per-model metadata)

**Model-specific license status** (which release `.tar.bz2` / asset has which `license_type`, `commercial_use`, provenance URL, etc.) is **not** stored here.

It is maintained as CSV and **bundled with the native library** so apps can ship it without extra Metro assets:

| Platform | Path (in this repo) |
|----------|---------------------|
| **Android** | [`android/src/main/assets/model_licenses/`](../android/src/main/assets/model_licenses/) |
| **iOS** | [`ios/Resources/model_licenses/`](../ios/Resources/model_licenses/) |

Files:

- `asr-models-license-status.csv` — ASR / STT release models  
- `tts-models-license-status.csv` — TTS release models  

Columns: `asset_name`, `license_type`, `commercial_use`, `confidence`, `detection_source`, `license_file`.

Set `detection_source` to `manual` for rows you maintain by hand; `scripts/ci/update_model_license_csv.sh` **never** re-scans or overwrites those assets (clear `manual` if you want automation to run again).

CI updates these CSVs via `scripts/ci/update_model_license_csv.sh`, which writes the primary file passed with `--csv` and **syncs the same content** to both Android and iOS paths above.

**Not legal advice** — consumers should verify licenses for their use case.

## License Types & Commercial Use

The following table explains the `license_type` and `commercial_use` values used in the CSV metadata.

| License Type | Commercial Use | Notes | Reference |
| :--- | :--- | :--- | :--- |
| **agpl-3.0** | `conditional` | Strong copyleft; requires source code disclosure if the model is used over a network. | [GNU AGPL v3](https://opensource.org/license/agpl-v3/) |
| **apache-2.0** | `yes` | Permissive license; allows commercial use, modification, and redistribution. | [Apache 2.0](https://opensource.org/license/apache-2-0/) |
| **bsd-3-clause** | `yes` | Permissive license; similar to MIT but includes a non-endorsement clause. | [BSD 3-Clause](https://opensource.org/license/bsd-3-clause/) |
| **cc-by** | `yes` | Attribution required; allows commercial use. | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| **cc-by-3.0** | `yes` | Attribution required; allows commercial use. | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| **cc-by-4.0** | `yes` | Attribution required; allows commercial use. | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| **cc-by-nc-4.0** | `no` | **Non-Commercial** use only. | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) |
| **cc-by-nc-nd-4.0** | `no` | **Non-Commercial** and no derivatives/modifications allowed. | [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) |
| **cc-by-nc-sa-4.0** | `no` | **Non-Commercial** and Share-Alike (derivatives must be under the same license). | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| **cc-by-sa** | `conditional` | Share-Alike; commercial use allowed, but any derivative must be under the same license. | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| **cc-by-sa-3.0-es** | `conditional` | Share-Alike (Spain jurisdiction). | [CC BY-SA 3.0 ES](https://creativecommons.org/licenses/by-sa/3.0/es/) |
| **cc-by-sa-4.0** | `conditional` | Share-Alike; commercial use allowed, but any derivative must be under the same license. | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| **cc0** | `yes` | Public domain; no restrictions on use. | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| **gpl-2.0** | `conditional` | Copyleft; requires sharing the source code of any derivative works. | [GNU GPL v2](https://opensource.org/license/gpl-2-0/) |
| **mit** | `yes` | Highly permissive; allows commercial use with simple attribution. | [MIT](https://opensource.org/license/mit/) |
| **ngc-terms-of-use** | `restricted` | NVIDIA NGC Terms; often restricts redistribution or specific commercial weight use. | [Terms](https://ngc.nvidia.com/legal/terms) |
| **no-license** | `no` | No explicit permission granted; all rights reserved by the author. | N/A |
| **nvidia-open-model-license** | `yes` | Allows commercial use under specific conditions (e.g. no benchmarking). | [License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) |
| **proprietary-restricted** | `no` | Closed or custom license with significant restrictions. | N/A |
| **public-domain** | `yes` | Free for any use; no copyright protection. | N/A |
| **research-only** | `no` | Limited strictly to non-commercial research and evaluation. | N/A |
| **unlicense** | `yes` | Public domain equivalent; no restrictions. | [Unlicense](https://unlicense.org/) |

### Commercial Use Status Definitions:
- **`yes`**: Allowed for commercial purposes with minimal restrictions (permissive).
- **`no`**: Explicitly forbidden for commercial purposes.
- **`conditional`**: Allowed, but requires adherence to specific distribution/license conditions (e.g. copyleft).
- **`restricted`**: Limited use or redistribution permitted; requires careful legal review.
