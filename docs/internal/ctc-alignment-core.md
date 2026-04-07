# Shared C++ CTC alignment core

Accurate subtitle alignment (`alignAccurateFromPath` / `alignAccurateFromFloat32`) uses a **single C++ implementation** of the wav2vec2 CTC pipeline:

- Source: `android/src/main/cpp/alignment/sherpa_onnx_ctc_alignment.hpp`, `sherpa_onnx_ctc_alignment.cpp`
- Steps: UTF-8 text + vocab JSON → token IDs, mono PCM → 16 kHz linear resample → mean/variance normalize → ONNX Runtime **C API** session → log-softmax → CTC backtracking → 20 ms frame word/char intervals.

## Android

- **CMake** (`android/src/main/cpp/CMakeLists.txt`): compiles the core, adds `third_party/onnxruntime/include`, links `libonnxruntime.so` from `android/src/main/jniLibs/<abi>/` (same artifact as the Java ORT bridge).
- **JNI** (`android/src/main/cpp/jni/alignment/sherpa-onnx-alignment-jni.cpp`): `Java_com_sherpaonnx_SherpaOnnxAlignmentHelper_nativeCtcAlignAccurate` → `sherpa_onnx::ctc_alignment::RunCtcAlignmentFromFloatPcm`, returns a `HashMap` with `words` / `chars` lists.
- **Kotlin** (`SherpaOnnxAlignmentHelper.kt`): WAV read / `content://` copy only; no Kotlin ORT API.

Load order: the app must load `libonnxruntime.so` before `libsherpaonnx.so` resolves `OrtGetApiBase` (see `SherpaOnnxModule` init).

## iOS

- **Podspec** (`SherpaOnnx.podspec`): compiles `sherpa_onnx_ctc_alignment.cpp` with the pod; header search includes `android/src/main/cpp/alignment` and `third_party/onnxruntime/include`.
- **Bridge** (`ios/SherpaOnnx+Alignment.mm`): reads WAV via `sherpa_onnx::cxx::ReadWave`, calls the same `RunCtcAlignmentFromFloatPcm`, maps the result to `NSDictionary` for React Native.

## Parity / upgrades

- Keep **ONNX Runtime** versions consistent between Android jniLibs, iOS embedded runtime, and `third_party/onnxruntime` headers used at compile time.
- For regression checks, run the same short WAV + model + transcript on Android and iOS and compare `words` / `chars` arrays (tolerance on floats if needed).

## Host tests (CI)

- **CMake**: `test/cpp/CMakeLists.txt` builds `ctc_alignment_host_test` on Linux/macOS when ONNX Runtime can be resolved. The default **`SHERPA_ONNX_HOST_ORT_VERSION`** is read from **`ONNXRUNTIME_VERSION=`** in [`third_party/onnxruntime_prebuilt/VERSIONS`](../../third_party/onnxruntime_prebuilt/VERSIONS) (not hardcoded). That matches the pinned upstream ORT semver used with the Android QNN prebuilts; [`android/prebuilt-versions.gradle`](../../android/prebuilt-versions.gradle) should stay aligned with the same pin. Host tests download the **official** Microsoft packages (`onnxruntime-linux-x64-${VER}.tgz`, etc. from [GitHub releases](https://github.com/microsoft/onnxruntime/releases)). After changing `VERSIONS`, re-run CMake with **`-USHERPA_ONNX_HOST_ORT_VERSION`** or delete `CMakeCache.txt` so the new default is picked up, unless you pass an explicit **`-DSHERPA_ONNX_HOST_ORT_VERSION=`** or **`-DSHERPA_ONNX_HOST_ORT_ROOT=`**.
- **Fixtures** (`test/fixtures/alignment/`):
  - `0-en.wav` — copied from the example app; **WavFixture** checks 16-bit mono PCM loads and has non-zero energy.
  - `relu_smoke.onnx` — tiny Relu IR8/opset 13; **OrtSmoke** loads and runs one session (validates ORT linkage at test time).
  - `tiny_ctc_linear.onnx` + `tiny_vocab.json` — single input `[1,100]`, logits `[1,5,6]` (MatMul+Reshape, IR8); **CtcAlignmentCore** calls `RunCtcAlignmentFromFloatPcm` with 100 samples at 16 kHz (smoke / regression guard for the shared C++ pipeline).
- **Workflow**: [`.github/workflows/test-audio-convert-host.yml`](../../.github/workflows/test-audio-convert-host.yml) runs `ctest` including these tests on Ubuntu.
