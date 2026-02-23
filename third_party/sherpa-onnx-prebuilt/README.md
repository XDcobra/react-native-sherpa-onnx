# sherpa-onnx Android prebuilts

This folder contains scripts to build sherpa-onnx native libraries for Android and copy them into the SDK. The resulting `.so` files are used by the React Native Android build.

## Building (Linux / macOS)

**Requirements:** Android NDK. Set one of `ANDROID_NDK`, `ANDROID_NDK_HOME`, or `ANDROID_NDK_ROOT`.

Initialize the sherpa-onnx submodule if needed:

```sh
git submodule update --init third_party/sherpa-onnx
```

### Without QNN (default)

Builds all ABIs (arm64-v8a, armeabi-v7a, x86, x86_64) **without** Qualcomm NPU support. No extra SDK required.

```sh
cd third_party/sherpa-onnx-prebuilt
./build_sherpa_onnx.sh
```

### With QNN (Qualcomm NPU) for arm64-v8a

To enable QNN acceleration on supported Snapdragon devices:

1. Download and install the [Qualcomm QNN SDK](https://qpm.qualcomm.com/) and set `QNN_SDK_ROOT` to its installation directory.
2. Run the build with the `--qnn` flag:

```sh
export QNN_SDK_ROOT=/path/to/qnn-sdk
cd third_party/sherpa-onnx-prebuilt
./build_sherpa_onnx.sh --qnn
```

If `QNN_SDK_ROOT` is not set or invalid, the script exits with a clear error before running CMake. See [sherpa-onnx QNN build docs](https://k2-fsa.github.io/sherpa/onnx/qnn/build.html) for details.

### Copy prebuilts into the SDK

After building, copy the `.so` files into the Android module’s `jniLibs`:

```sh
node copy_prebuilts_to_sdk.js
```

Or run the repo’s setup script from the repo root: `node scripts/setup-assets.js` (it will copy prebuilts if present).

## Output layout

- `android/<abi>/lib/*.so` – built libraries (e.g. `libsherpa-onnx-jni.so`, `libonnxruntime.so`).
- `copy_prebuilts_to_sdk.js` copies them to `android/src/main/jniLibs/<abi>/` for the Gradle build.
