# sherpa-onnx Android prebuilts

This folder contains scripts to build sherpa-onnx native libraries for Android and copy them into the SDK. The resulting `.so` files are used by the React Native Android build.

**ONNX Runtime source:** The build **always** uses this repo’s GitHub Release (tag `ort-android-qnn-v*`, see `third_party/onnxruntime_prebuilt/VERSIONS`) when available. That release is built by `.github/workflows/build-onnxruntime-android-release.yml`. If the release is missing or the download fails, the script falls back to sherpa-onnx’s default (onnxruntime-libs). So the SDK is no longer tied to the stock onnxruntime from sherpa-onnx once the ORT+QNN release exists.

## Building (Linux / macOS)

**Requirements:** Android NDK (set one of `ANDROID_NDK`, `ANDROID_NDK_HOME`, or `ANDROID_NDK_ROOT`). For the default **Kotlin API** build, **Android SDK** is also required (set `ANDROID_HOME` or `ANDROID_SDK_ROOT`) so that `android.jar` is available when compiling the Kotlin API.

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

## API variant: Kotlin (default) vs Java

By default the script builds the **Kotlin API** (data classes, `WaveReader.readWave()`, etc.) so that Kotlin and React Native apps can use the same API style as the official sherpa-onnx AAR. You can switch to the Java API (Builder pattern) or build both:

- `./build_sherpa_onnx.sh` — Kotlin API → `android/java/classes.jar` (default).
- `./build_sherpa_onnx.sh --java` — Java API only → `android/java/classes.jar`.
- `./build_sherpa_onnx.sh --both` — Kotlin → `classes.jar`, Java → `classes-java.jar` (for publishing a second Maven artifact with classifier `java`).

**Publishing Kotlin and Java to Maven:** Use the same version and distinguish by **classifier**. Default AAR = Kotlin API. To publish a Java-only AAR, build with `--java` and publish that AAR with classifier `java`, e.g. `com.xdcobra.sherpa:sherpa-onnx:VERSION:java@aar`. Consumers then choose:

- Kotlin/default: `com.xdcobra.sherpa:sherpa-onnx:VERSION` (or `@aar`).
- Java: `com.xdcobra.sherpa:sherpa-onnx:VERSION:java@aar`.

## Output layout

- `android/<abi>/lib/*.so` – built libraries (e.g. `libsherpa-onnx-jni.so`, `libonnxruntime.so`).
- `android/java/classes.jar` – sherpa-onnx API (default: Kotlin from `sherpa-onnx/kotlin-api`; or Java from `sherpa-onnx/java-api` when using `--java`). With `--both`, `classes-java.jar` is also produced.
- `copy_prebuilts_to_sdk.js` copies the `.so` files to `android/src/main/jniLibs/<abi>/` for the Gradle build.
