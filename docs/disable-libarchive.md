# Disabling libarchive in the Android build

If your app uses another native library that ships its own libarchive, or you do not need archive extraction (e.g. `.tar.bz2` model extraction), you can disable libarchive in this SDK. When disabled, no `libarchive.so` is linked or shipped, and archive-dependent APIs return an error at runtime.

## Gradle flag

In your app or the SDK consumer project, set in **`gradle.properties`** (project or root):

```properties
sherpaOnnxDisableLibarchive=true
```

Alternatively pass it as a project property, e.g.:

```bash
./gradlew assembleRelease -PsherpaOnnxDisableLibarchive=true
```

When this is set:

- The Android native build **does not** link or ship libarchive from this SDK (no `libarchive.so`).
- Prebuilt download and `checkJniLibs` **do not** require libarchive libs or headers.
- The build completes successfully without libarchive prebuilts or AAR.

## Functions that depend on libarchive

When libarchive is disabled, the following APIs are **built but return an error at runtime** when called:

| API | Description |
|-----|-------------|
| **`extractTarBz2(sourcePath, targetPath, force, promise)`** | Extracts a `.tar.bz2` archive (e.g. a downloaded model bundle) to a target folder. Implemented in native code via libarchive; when disabled, the native implementation is not linked and the promise is rejected with an error message. |
| **`cancelExtractTarBz2()`** | Cancels an ongoing `extractTarBz2` operation. When libarchive is disabled, there is no extraction implementation to cancel; calling this is a no-op. |

Both are exposed on the **`NativeSherpaOnnx`** spec (e.g. from `react-native-sherpa-onnx`). The progress event `extractTarBz2Progress` will not be emitted when extraction is disabled, because extraction never runs.

## Functions that still work without libarchive

| API | Description |
|-----|-------------|
| **`computeFileSha256(filePath, promise)`** | Computes the SHA-256 hash of a file. Implemented using only standard I/O and the bundled crypto code; it does **not** use libarchive. You can call it regardless of the libarchive flag. |

All other features (STT, TTS, FFmpeg-based audio conversion, model detection, etc.) are unaffected by the libarchive flag.

## Download Manager (`react-native-sherpa-onnx/download`)

The [Model Download Manager](download-manager.md) uses native `extractTarBz2` for **archive models** (`.tar.bz2`). When libarchive is disabled, the following behavior applies:

| API | Effect when libarchive is disabled |
|-----|-------------------------------------|
| **`downloadModelByCategory(category, id, options?)`** | For **archive models** (`.tar.bz2`): the file download completes, but the extraction step fails (native `extractTarBz2` is stubbed). The returned promise **rejects**; the model is not usable. For **single-file models** (`.onnx`): no extraction is used; download and usage work as normal. |
| **`getLocalModelPathByCategory(category, id)`** | Archive models are only considered “downloaded” after extraction and manifest write. When extraction never succeeds, they never appear; this returns `null` for archive models that were not previously extracted with libarchive enabled. Single-file models are unaffected. |
| **`listDownloadedModelsByCategory(category)`** | Only lists models that have a complete manifest (download + extraction done). Archive models whose extraction failed will not appear. Single-file models work as usual. |
| **`isModelDownloadedByCategory(category, id)`** | Returns `true` only when the model is fully downloaded and (for archives) extracted. Archive models fail extraction when libarchive is disabled, so they will not be reported as downloaded. |
| **`subscribeDownloadProgress(listener)`** | Progress events for the **extracting** phase come from native extraction. When libarchive is disabled, extraction fails immediately after the download phase; the listener may see download progress, then the overall operation fails. |
| **`refreshModelsByCategory`**, **`listModelsByCategory`**, **`getModelByIdByCategory`**, **`deleteModelByCategory`**, **`clearModelCacheByCategory`** | Do not depend on extraction; they work regardless of the libarchive flag. |

**Summary:** With libarchive disabled, **archive models** (`.tar.bz2`) cannot be fully downloaded or used via the download manager; only **single-file models** (`.onnx`) can be downloaded and used through it. If you need archive-based models (e.g. from the official sherpa-onnx release list), do not disable libarchive, or provide extraction by other means and do not use `downloadModelByCategory` for those models.

## Risks and limitations of disabling libarchive

1. **No built-in .tar.bz2 extraction**  
   You must not call `extractTarBz2` when libarchive is disabled, or handle the rejection (e.g. show a message or use another extraction path). If your app relies on this to unpack model bundles, you need to extract archives by other means (e.g. a JS/native library that provides tar.bz2 extraction) or ship models in a non-archive format.

2. **No runtime use of another libarchive**  
   Disabling libarchive here means this SDK’s native code is **compiled without** libarchive; the extraction helper is stubbed and always returns an error. The SDK does **not** call into another app-provided libarchive. You avoid shipping a duplicate `libarchive.so`; you do not get “shared” libarchive behavior.

3. **No version/ABI coupling**  
   Because this SDK no longer links or uses libarchive when disabled, there is no risk of ABI or version mismatch with another libarchive in the process. You can safely have both this SDK (with libarchive disabled) and another library that ships libarchive in the same app.

## When crashes can still occur

- **If libarchive is *not* disabled** and your app (or another dependency) also loads a different libarchive (e.g. another `libarchive.so`), then **two** libarchive implementations can be in the same process. Depending on load order and symbol resolution, you can get symbol conflicts or undefined behavior.

  **Mitigation:** Set `sherpaOnnxDisableLibarchive=true` so this SDK does not ship or use libarchive; then only one libarchive (or none from this SDK) is present.

- **If libarchive is disabled** and you still call `extractTarBz2`, the promise is rejected with an error (e.g. “libarchive not available…”). It does **not** crash the process; your app should handle the rejection (e.g. use another extraction path or show a message).

## Summary

| Setting | Effect |
|--------|--------|
| **`sherpaOnnxDisableLibarchive=true`** in `gradle.properties` | No libarchive linked or shipped; build succeeds without libarchive prebuilts; `extractTarBz2` rejects with an error at runtime; `cancelExtractTarBz2` is a no-op; `computeFileSha256` still works. **Download Manager:** only single-file models (`.onnx`) can be downloaded and used; archive models (`.tar.bz2`) fail at extraction. Use when you have another libarchive in the app or do not need archive extraction. |
| **Default (flag unset or false)** | libarchive is required; prebuilts or AAR must provide libarchive; `extractTarBz2` and `cancelExtractTarBz2` work; Download Manager supports both archive and single-file models. Do not combine with another libarchive in the same process unless you accept the risk of clashes. |
