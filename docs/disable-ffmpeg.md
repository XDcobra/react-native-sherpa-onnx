# Disabling FFmpeg in the Android build

If your app uses another native library that ships its own FFmpeg, having two copies of FFmpeg in the same process can cause **symbol clashes** and crashes. You can disable FFmpeg in this SDK so that only the other library’s FFmpeg is used, and no duplicate FFmpeg is linked or shipped.

## Gradle flag

In your app or the SDK consumer project, set in **`gradle.properties`** (project or root):

```properties
sherpaOnnxDisableFfmpeg=true
```

Alternatively pass it as a project property, e.g.:

```bash
./gradlew assembleRelease -PsherpaOnnxDisableFfmpeg=true
```

When this is set:

- The Android native build **does not** link or ship any FFmpeg libraries from this SDK (no `libavcodec.so`, `libavformat.so`, etc.).
- Prebuilt download and `checkJniLibs` **do not** require FFmpeg libs or headers.
- The build completes successfully without FFmpeg prebuilts or AAR.

## Functions that depend on FFmpeg

When FFmpeg is disabled, the following APIs are **built but return an error at runtime** when called:

| API | Description |
|-----|-------------|
| **`convertAudioToWav16k(inputPath, outputPath)`** | Converts an audio file to WAV 16 kHz mono 16-bit PCM (sherpa-onnx input format). Implemented in native code via FFmpeg; when disabled, the native implementation is not linked and the call returns an error string. |
| **`convertAudioToFormat(inputPath, outputPath, format, outputSampleRateHz?)`** | Converts an audio file to a given format (e.g. `"wav"`, `"mp3"`, `"flac"`). WAV output is 16 kHz mono; MP3 uses libshine and optional sample rate. Same as above: when FFmpeg is disabled, the call returns an error. |

Both are exposed from the **`react-native-sherpa-onnx/audio`** module (e.g. `convertAudioToWav16k`, `convertAudioToFormat`). All other features (STT, TTS, archive extraction, model detection, etc.) do **not** depend on FFmpeg and continue to work.

## Risks and limitations of disabling FFmpeg

1. **No built-in audio conversion**  
   You must not call `convertAudioToWav16k` or `convertAudioToFormat` when FFmpeg is disabled, or handle the error (e.g. show a message or use another path). If your app relies on these to produce 16 kHz WAV for sherpa-onnx, you need to provide that input via another library (e.g. decode with react-native-sound-api and then resample/write WAV yourself) or pass already-decoded PCM / paths that don’t require these helpers.

2. **No runtime use of “the other” FFmpeg**  
   Disabling FFmpeg here means this SDK’s native code is **compiled without** FFmpeg; the conversion helpers are stubbed and always return an error. The SDK does **not** call into another app’s FFmpeg (e.g. from sound-api). So you avoid symbol clashes by simply not using FFmpeg in this SDK at all; you do not get “shared” FFmpeg behavior.

3. **No version/ABI coupling**  
   Because this SDK no longer links or uses any FFmpeg when disabled, there is no risk of ABI or version mismatch with another FFmpeg in the process. You can safely have both this SDK (with FFmpeg disabled) and e.g. react-native-sound-api (with its own FFmpeg) in the same app.

## When crashes can still occur

- **If FFmpeg is *not* disabled** and your app (or another dependency) also loads a different FFmpeg (e.g. `libavcodec.so` from sound-api), then **two** FFmpeg implementations are in the same process. The dynamic linker resolves symbols globally; depending on load order and version differences, you can get:
  - Crashes or undefined behavior when one library’s code runs with the other’s structures or version.
  - Symbol conflicts (e.g. `av_codec_next`, `avformat_open_input`) leading to wrong function or ABI mismatch.

  **Mitigation:** Set `sherpaOnnxDisableFfmpeg=true` so this SDK does not ship or use FFmpeg; then only the other library’s FFmpeg is present and no clash occurs.

- **If FFmpeg is disabled** and you still call `convertAudioToWav16k` or `convertAudioToFormat`, the call returns an error (e.g. “FFmpeg not available…”). It does **not** crash the process; your app should check the result and avoid or handle the error (e.g. use another conversion path or show a message).

## Summary

| Setting | Effect |
|--------|--------|
| **`sherpaOnnxDisableFfmpeg=true`** in `gradle.properties` | No FFmpeg linked or shipped; build succeeds without FFmpeg prebuilts; `convertAudioToWav16k` / `convertAudioToFormat` return an error at runtime. Use when you have another FFmpeg in the app (e.g. sound-api) to avoid symbol clashes. |
| **Default (flag unset or false)** | FFmpeg is required; prebuilts or AAR must provide FFmpeg libs and headers; conversion APIs work. Do not combine with another FFmpeg in the same process unless you accept the risk of clashes. |
