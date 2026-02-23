# ONNX Runtime Android prebuilts

Build ONNX Runtime for Android (all ABIs) for use with sherpa-onnx. Optional **QNN** (Qualcomm NPU, arm64-v8a only) and **NNAPI** support.

## Version pinning and GitHub Release

- **`VERSIONS`** – Pins `ONNXRUNTIME_VERSION` and `QNN_SDK_VERSION`. Used by:
  - **`.github/workflows/build-onnxruntime-qnn.yml`** – Builds ORT with QNN, downloads the QNN SDK from Qualcomm, and publishes a **GitHub Release** with tag `ort-android-qnn-v<ORT>-qnn<QNN>` and asset `onnxruntime-android-qnn.zip`.
  - **`third_party/sherpa-onnx-prebuilt/build_sherpa_onnx.sh`** – When building sherpa-onnx for Android, **always** tries to download this release and use it instead of onnxruntime-libs. If the release is missing or download fails, sherpa-onnx falls back to its default download.

No changes to the sherpa-onnx submodule are required (Variant B).

## Why build ONNX Runtime here?

The sherpa-onnx Android build uses a **downloaded** ONNX Runtime prebuilt (from onnxruntime-libs), which does **not** include the QNN execution provider. To get QNN support in sherpa-onnx on Android, you must build ONNX Runtime from source with QNN and then point sherpa-onnx at these prebuilts. This folder provides a script to build ORT for all ABIs with optional QNN and NNAPI.

## Requirements

- **Android NDK** – set `ANDROID_NDK` (or `ANDROID_NDK_HOME` / `ANDROID_NDK_ROOT`)
- **Android SDK** – set `ANDROID_HOME` (or `ANDROID_SDK_ROOT` / `ANDROID_SDK_PATH`)
- **Python 3** – used by ONNX Runtime’s build system
- For **QNN**: [Qualcomm QNN SDK](https://qpm.qualcomm.com/), set `QNN_SDK_ROOT`

Initialize the submodule if needed:

```sh
git submodule update --init third_party/onnxruntime
```

## Building

### Without QNN (default), with NNAPI

```sh
cd third_party/onnxruntime_prebuilt
./build_onnxruntime.sh
```

### With QNN for arm64-v8a

```sh
export QNN_SDK_ROOT=/path/to/qnn-sdk
cd third_party/onnxruntime_prebuilt
./build_onnxruntime.sh --qnn
```

### Without NNAPI

```sh
./build_onnxruntime.sh --no-nnapi
```

## Output layout

- `android/<abi>/lib/libonnxruntime.so` – built library per ABI
- `android/<abi>/headers/` – ONNX Runtime headers (same for all ABIs; copied per ABI for convenience)

Use these paths as `SHERPA_ONNXRUNTIME_LIB_DIR` and `SHERPA_ONNXRUNTIME_INCLUDE_DIR` when building sherpa-onnx for each ABI (e.g. in a modified sherpa-onnx Android build that uses your ORT prebuilts instead of downloading the default zip).

## References

- [Build ONNX Runtime for Android](https://onnxruntime.ai/docs/build/android.html)
- [QNN Execution Provider (Android)](https://onnxruntime.ai/docs/build/android.html#qnn-execution-provider)
- [QNN EP build options](https://onnxruntime.ai/docs/build/eps.html#qnn)
