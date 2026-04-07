# Android prebuilt resolution

Every externally supplied Android artifact (native `.so`, C headers, `classes.jar`) is resolved through a unified priority cascade implemented in `android/prebuilt-download.gradle`.

## Priority stages

| Stage | Label | Meaning |
|------:|-------|---------|
| **1** | `THIRD_PARTY` | Prebuilt files committed under `third_party/<bundle>/android/` — no network required. Requires both JNI libs and headers to be complete; partial trees fall through to stage 3. |
| **2** | `LOCAL_SDK` | Already present under the Android library module (`android/src/main/jniLibs/<abi>/`, `android/src/main/cpp/include/…`) with a matching version stamp under `android/build/prebuilt-downloads/*-version.txt`. |
| **3** | `MAVEN_AAR` | Gradle configurations: `sherpaOnnxAar`, `ffmpegAar`, `libarchiveAar`, `onnxruntimeAar` (e.g. `com.xdcobra.sherpa:*`). |
| **4** | `GITHUB_RELEASE` | `curl` from `https://github.com/<repo>/releases/download/<tag>/<asset>.zip`. The tag is read from `third_party/*/ANDROID_RELEASE_TAG`. |
| **5** | `ERROR` | `RuntimeException` / failed build when a required artifact is still missing after all applicable stages. |

**Optional skips:** FFmpeg and libarchive are skipped entirely when `sherpaOnnxDisableFfmpeg` or `sherpaOnnxDisableLibarchive` is set in `gradle.properties`; see [disable-ffmpeg.md](./disable-ffmpeg.md) and [disable-libarchive.md](./disable-libarchive.md).

## Artifact matrix

For each row, resolution tries **1 --> 2 --> 3 --> 4** in order; **5** applies if nothing satisfied the requirement.

| Package | Part | Contents / notes | `third_party` layout (stage 1) | Stage 2 (module) | Stage 3 (Maven) | Stage 4 (GitHub asset) |
|---------|------|------------------|-------------------------------|------------------|-----------------|-------------------------|
| **sherpa-onnx** | JNI | `libsherpa-onnx-jni.so`, `libsherpa-onnx-c-api.so`, `libsherpa-onnx-cxx-api.so` per ABI (**no** `libonnxruntime.so`; use ONNX Runtime AAR) | `third_party/sherpa-onnx-prebuilt/android/jni/<abi>/*.so` | `src/main/jniLibs/<abi>/` | `sherpaOnnxAar` --> `jni/<abi>/` | `sherpa-onnx-android.zip` --> `<abi>/**` |
| **sherpa-onnx** | C headers | `c-api/**` (e.g. `c-api.h`) | `third_party/sherpa-onnx-prebuilt/android/include/sherpa-onnx/c-api/**` | `src/main/cpp/include/sherpa-onnx/` | AAR `c-api/**` | ZIP `c-api/**` |
| **sherpa-onnx** | Java/Kotlin API | `classes.jar` | `third_party/sherpa-onnx-prebuilt/android/java/classes.jar` | (build dir from previous run) | `sherpaOnnxAar` --> `classes.jar` | ZIP `java/classes.jar` or extract cache |
| **FFmpeg** | JNI | `libavcodec.so`, `libavformat.so`, `libavutil.so`, `libswresample.so`, `libavfilter.so`, `libshine.so` | `third_party/ffmpeg_prebuilt/android/jni/<abi>/` | `src/main/jniLibs/<abi>/` | `ffmpegAar` | `ffmpeg-android.zip` |
| **FFmpeg** | C headers | `libavcodec/avcodec.h` etc. | `third_party/ffmpeg_prebuilt/android/include/**` | `src/main/cpp/include/ffmpeg/` | AAR `include/**` | ZIP `include/**` |
| **libarchive** | JNI | `libarchive.so`, `libzstd.so` | `third_party/libarchive_prebuilt/android/jni/<abi>/` | `src/main/jniLibs/<abi>/` | `libarchiveAar` | `libarchive-android.zip` |
| **libarchive** | C headers | `archive.h` | `third_party/libarchive_prebuilt/android/include/**` | `src/main/cpp/include/libarchive/` | AAR `include/**` | ZIP `include/**` |
| **ONNX Runtime** | JNI + core `.so` | **`libonnxruntime4j_jni.so` and `libonnxruntime.so` from the same bundle** (AAR or full `third_party`). Single source for Java ORT and native Sherpa runtime dependency. | `third_party/onnxruntime_prebuilt/android/jni/<abi>/` (both files) | `src/main/jniLibs/<abi>/` | `onnxruntimeAar` → copy both per ABI | — |
| **ONNX Runtime** | Java API | `classes.jar` → `onnxruntime-classes.jar` in build dir | — | — | `onnxruntimeAar` | — |
| **ONNX Runtime** | C/C++ headers | `include/**` inside the published AAR (for native consumers) | — | — | `onnxruntimeAar` (optional extract) | — |

**ORT release tag / Maven version:** `third_party/onnxruntime_prebuilt/ANDROID_RELEASE_TAG` uses `ort-android-qnn-v<version>` where `<version>` is the Maven coordinate suffix, e.g. `1.24.4-qnn2.43.1.260218-1` (trailing `-N` is an **ORT build number** for rebuilds at the same ORT+QNN pin). `android/prebuilt-versions.gradle` strips the prefix and uses the remainder as `ortVersion`.

## Gradle tasks

| Task | Responsibility |
|------|---------------|
| `downloadNativeLibsIfNeeded` | JNI `.so`, C headers, and version stamps for all four packages. Runs stages 1-->2-->3-->4 per package. |
| `checkJniLibs` | Hard-fails if any required `.so` is missing after `downloadNativeLibsIfNeeded`. Depends on it. |
| `extractSherpaOnnxClasses` | Sherpa `classes.jar` into `build/sherpa-onnx-classes`. Resolution: THIRD_PARTY --> MAVEN_AAR --> GITHUB_EXTRACT. |
| `extractOnnxruntimeClasses` | ORT `classes.jar` into `build/onnxruntime-classes`. Currently Maven only. |

**Versions** are defined in `android/prebuilt-versions.gradle`; AAR configurations in `android/build.gradle`.
