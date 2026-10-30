# Disabling FFmpeg (Android & iOS)

By default, the `react-native-sherpa-onnx` SDK includes and links prebuilt FFmpeg binaries (`FFmpeg.xcframework` for iOS and `.so` libs for Android) to provide built-in audio save and transcoding features.

You can explicitly **disable FFmpeg** in this SDK if you want to:
1. **Reduce App Size:** Omit FFmpeg binaries if you do not use audio save helpers (`saveAudioAsWav16k`, `saveAudioAsFile`).
2. **Prevent Symbol Clashes:** Avoid duplicate native symbols if another native module or library in your app already ships its own FFmpeg (e.g. `react-native-sound-api` or `ffmpeg-kit-react-native`). Having two copies of FFmpeg in the same process can cause runtime crashes or undefined behavior.

## How to disable FFmpeg

### Android (Gradle)

In your app or the SDK consumer project, set the following property in your **`gradle.properties`** (project or root):

```properties
sherpaOnnxDisableFfmpeg=true
```

Alternatively pass it as a project property via CLI:

```bash
./gradlew assembleRelease -PsherpaOnnxDisableFfmpeg=true
```

When this is set:
- The Android native build **does not** link or ship any FFmpeg libraries from this SDK.
- Prebuilt download scripts and `checkJniLibs` **do not** require FFmpeg prebuilts.

### iOS (CocoaPods)

For iOS, you can disable FFmpeg by setting the `SHERPA_ONNX_DISABLE_FFMPEG` environment variable when running `pod install`.

```bash
export SHERPA_ONNX_DISABLE_FFMPEG=1
cd ios && pod install
```

When this is set:
- The `setup-ios-framework.sh` script skips downloading `FFmpeg.xcframework`.
- `SherpaOnnx.podspec` ignores any existing FFmpeg frameworks, meaning they won't be linked in Xcode and `HAVE_FFMPEG=1` will not be defined.

## Functions that depend on FFmpeg

When FFmpeg is disabled, the following APIs are **built but return an error at runtime** when called:

| API | Description |
|-----|-------------|
| **`saveAudioAsWav16k(input, output)`** | Saves a buffer or `FileSource` as 16 kHz mono WAV. Builds without FFmpeg may reject when a backend path requires FFmpeg. |
| **`saveAudioAsFile(input, output, format, options?)`** | Saves a buffer or `FileSource` to the requested output format. Non-WAV formats require FFmpeg. |
| **`probeVideoFileDuration(source)`** | Reads clip duration from container metadata. Rejects with `VIDEO_FFMPEG_DISABLED` (JS wrapper returns `null`). |
| **`probeVideoFileContainer(source)`** | Sniffs container + video codec from file content. Rejects with `VIDEO_FFMPEG_DISABLED` (JS wrapper returns `null`). |
| **`createOfflineVideoBufferFromFile(source)`** | Opens a `FileSource` container (`mov` / `matroska`) via libavformat. Rejects with `VIDEO_FFMPEG_DISABLED`. |
| **`ingestFileToLiveVideoBuffer(source, live)`** | Remuxes a `FileSource` into a live video buffer. Rejects with `VIDEO_FFMPEG_DISABLED`. |
| **`createOfflineAudioBufferFromVideo(video)`** | Decodes the container audio track through FFmpeg. Rejects with `VIDEO_FFMPEG_DISABLED`. |
| **`createLiveAudioBufferFromLiveVideo(live)`** | Live audio tap decode. Rejects with `VIDEO_FFMPEG_DISABLED`. |
| **`exportVideo(video, output, format, options?)`** | HW-encodes the clip, then muxes with FFmpeg (`mp4`/`mov`/`mkv`/`webm`). Rejects with `VIDEO_FFMPEG_DISABLED`. |
| **`createVideoPreviewPlayer` audio track** | Preview audio uses FFmpeg SW decode. Video still plays; `audioUnavailable` / status `unavailable`. |

The audio helpers above are exposed from **`react-native-sherpa-onnx/audio`**. Video file APIs are from **`react-native-sherpa-onnx/videobuffer`**. Live video buffers fed by native producers (no file demux) keep working. STT, archive extraction, model detection, and general pipeline buffer operations continue to work when FFmpeg is disabled.

## Risks and limitations of disabling FFmpeg

1. **No built-in FFmpeg-backed transcoding**  
   You must not call `saveAudioAsFile` for formats that require FFmpeg when FFmpeg is disabled, or you must handle the rejection gracefully.

2. **No runtime use of “the other” FFmpeg**  
   Disabling FFmpeg here means this SDK’s native code is **compiled without** FFmpeg support. The SDK does **not** call into another app’s FFmpeg. So you avoid symbol clashes by simply not using FFmpeg in this SDK at all; you do not get “shared” FFmpeg behavior.

3. **No version/ABI coupling**  
   Because this SDK no longer links or uses any FFmpeg when disabled, there is no risk of ABI or version mismatch with another FFmpeg in the process. You can safely have both this SDK (with FFmpeg disabled) and e.g. `ffmpeg-kit-react-native` (with its own FFmpeg) in the same app.

## Summary

| Setting | Effect |
|--------|--------|
| **Android:** `sherpaOnnxDisableFfmpeg=true`<br>**iOS:** `SHERPA_ONNX_DISABLE_FFMPEG=1 pod install` | No FFmpeg linked or shipped. `saveAudioAsFile` rejects for FFmpeg-backed formats. Use to reduce app size or when you have another FFmpeg in the app to avoid symbol clashes. |
| **Default (Flag unset / false)** | FFmpeg is bundled automatically. Audio save APIs work for all documented formats. Do not combine with another FFmpeg in the same process unless you accept the risk of symbol clashes. |

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

