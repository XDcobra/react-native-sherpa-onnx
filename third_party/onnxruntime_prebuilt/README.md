# ONNX Runtime Android prebuilts

Build ONNX Runtime for Android (all ABIs) for use with sherpa-onnx. Optional **QNN** (Qualcomm NPU, arm64-v8a only) and **NNAPI** support.

## Version pinning and GitHub Release

- **`VERSIONS`** – Pins `ONNXRUNTIME_VERSION` and `QNN_SDK_VERSION`. Used by:
  - **`.github/workflows/build-onnxruntime-qnn.yml`** – Builds ORT for all ABIs with QNN, NNAPI, XNNPACK, Java; publishes a **GitHub Release** with tag `ort-android-qnn-v<ORT>-qnn<QNN>` and assets `onnxruntime-android-qnn.aar` and `onnxruntime-android-qnn.zip`.
  - **`third_party/sherpa-onnx-prebuilt/build_sherpa_onnx.sh`** – When building sherpa-onnx for Android, tries to download this release and use the zip; or uses local output of `build_onnxruntime_android_aar.sh` if present.

No changes to the sherpa-onnx submodule are required (Variant B).

## Why build ONNX Runtime here?

The sherpa-onnx Android build uses a **downloaded** ONNX Runtime prebuilt (from onnxruntime-libs), which does **not** include the QNN execution provider. To get QNN support in sherpa-onnx on Android, you must build ONNX Runtime from source with QNN and then point sherpa-onnx at these prebuilts. This folder provides a script to build ORT for all ABIs (with optional QNN, NNAPI, XNNPACK, Java) and produce an Android AAR.

## Requirements

- **Android NDK** – set `ANDROID_NDK` (or `ANDROID_NDK_HOME` / `ANDROID_NDK_ROOT`)
- **Android SDK** – set `ANDROID_HOME` (or `ANDROID_SDK_ROOT` / `ANDROID_SDK_PATH`)
- **Python 3** – used by ONNX Runtime’s build system
- For **QNN**: [Qualcomm QNN SDK](https://qpm.qualcomm.com/), set `QNN_SDK_ROOT`
- For **AAR**: **JDK 17** (set `JAVA_HOME`; AGP 7.4.2 fails with Java 21)

Initialize the submodule if needed:

```sh
git submodule update --init third_party/onnxruntime
```

## Building

### Full build (all ABIs, QNN + NNAPI + XNNPACK + Java → .aar)

```sh
export QNN_SDK_ROOT=/path/to/qnn-sdk   # required for QNN
cd third_party/onnxruntime_prebuilt
./build_onnxruntime_android_aar.sh
```

### Without QNN

```sh
./build_onnxruntime_android_aar.sh --no-qnn
```

### Without NNAPI

```sh
./build_onnxruntime_android_aar.sh --no-nnapi
```

### Native libs + headers only (no AAR)

```sh
./build_onnxruntime_android_aar.sh --no-aar
```

## Output layout

- `android-arm64-qnn-nnapi-xnnpack/<abi>/lib/` – `libonnxruntime.so`, `libonnxruntime4j_jni.so` per ABI
- `android-arm64-qnn-nnapi-xnnpack/<abi>/headers/` – ONNX Runtime headers (same for all ABIs)
- `android-arm64-qnn-nnapi-xnnpack/aar_out/onnxruntime-release.aar` – Android AAR (all ABIs)

Use `android-arm64-qnn-nnapi-xnnpack` as base for `SHERPA_ONNXRUNTIME_LIB_DIR` (layout: `<base>/<abi>/lib`) and `SHERPA_ONNXRUNTIME_INCLUDE_DIR` (e.g. `<base>/arm64-v8a/headers`) when building sherpa-onnx. The workflow and `build_sherpa_onnx.sh` also accept this path automatically.

## References

- [Build ONNX Runtime for Android](https://onnxruntime.ai/docs/build/android.html)
- [QNN Execution Provider (Android)](https://onnxruntime.ai/docs/build/android.html#qnn-execution-provider)
- [QNN EP build options](https://onnxruntime.ai/docs/build/eps.html#qnn)
