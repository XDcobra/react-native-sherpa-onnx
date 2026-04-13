# Disabling FFmpeg (Android & iOS)

By default, the `react-native-sherpa-onnx` SDK includes and links prebuilt FFmpeg binaries (`FFmpeg.xcframework` for iOS and `.so` libs for Android) to provide built-in audio conversion features for pipeline buffers.

You can explicitly **disable FFmpeg** in this SDK if you want to:
1. **Reduce App Size:** Omit FFmpeg binaries if you do not use conversion helpers (`convertAudioToWav16k`, `convertAudioToFormat`).
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
| **`convertAudioToWav16k(input, outputPath)`** | Converts an offline/finalized live buffer to WAV 16 kHz mono 16-bit PCM. Without FFmpeg, rejects at runtime. |
| **`convertAudioToFormat(input, outputPath, format, outputSampleRateHz?)`** | Converts an offline/finalized live buffer to the requested output format. Without FFmpeg, rejects at runtime. |

The helpers above are exposed from **`react-native-sherpa-onnx/audio`**. STT, archive extraction, model detection, and general pipeline buffer operations continue to work when FFmpeg is disabled.

## Risks and limitations of disabling FFmpeg

1. **No built-in audio conversion**  
   You must not call `convertAudioToWav16k` or `convertAudioToFormat` when FFmpeg is disabled, or handle the rejection gracefully.

2. **No runtime use of “the other” FFmpeg**  
   Disabling FFmpeg here means this SDK’s native code is **compiled without** FFmpeg; the conversion helpers are stubbed and always return an error. The SDK does **not** call into another app’s FFmpeg. So you avoid symbol clashes by simply not using FFmpeg in this SDK at all; you do not get “shared” FFmpeg behavior.

3. **No version/ABI coupling**  
   Because this SDK no longer links or uses any FFmpeg when disabled, there is no risk of ABI or version mismatch with another FFmpeg in the process. You can safely have both this SDK (with FFmpeg disabled) and e.g. `ffmpeg-kit-react-native` (with its own FFmpeg) in the same app.

## Summary

| Setting | Effect |
|--------|--------|
| **Android:** `sherpaOnnxDisableFfmpeg=true`<br>**iOS:** `SHERPA_ONNX_DISABLE_FFMPEG=1 pod install` | No FFmpeg linked or shipped. `convertAudioToWav16k` / `convertAudioToFormat` reject at runtime. Use to reduce app size or when you have another FFmpeg in the app to avoid symbol clashes. |
| **Default (Flag unset / false)** | FFmpeg is required and bundled automatically. Conversion APIs work out of the box. Do not combine with another FFmpeg in the same process unless you accept the risk of symbol clashes. |
