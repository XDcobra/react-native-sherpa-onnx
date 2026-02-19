# Model Setup Guide

This guide explains how to set up and discover STT/TTS models with `react-native-sherpa-onnx`, and when to use which API for listing and selecting models.

**Auto-detection:** The library detects model types from the **files present** in each model directory. Folder and file names do not need to follow any fixed convention.

For supported model types and file requirements per type, see the [Supported Model Types](../../README.md#supported-model-types) section in the root README.

---

## Table of Contents

- [Quick usage: Bundled assets](#quick-usage-bundled-assets)
- [Quick usage: Play Asset Delivery (PAD)](#quick-usage-play-asset-delivery-pad)
- [Public API for model discovery and paths](#public-api-for-model-discovery-and-paths)
- [Advanced](#advanced)
- [Troubleshooting](#troubleshooting)

---

## Quick usage: Bundled assets

Models are shipped inside your app bundle (APK/IPA) under a dedicated assets path.

### Example file tree

```
# Android: app/src/main/assets/
assets/
  models/
    sherpa-onnx-whisper-tiny-en/
      encoder.onnx
      decoder.onnx
      tokens.txt
    vits-piper-en_US-lessac-low/
      model.onnx
      tokens.txt

# iOS: add folder as "folder reference" (blue) in Xcode, e.g. under a "models" group
# Resulting asset path: models/sherpa-onnx-whisper-tiny-en, models/vits-piper-en_US-lessac-low
```

### Typical code flow

1. **List** model folders in assets with `listAssetModels()`.
2. **Resolve** the chosen folder to an absolute path with `resolveModelPath({ type: 'asset', path: 'models/<folder>' })`.
3. **Initialize** STT or TTS with that path (and `modelType: 'auto'` to rely on auto-detection).

```typescript
import {
  listAssetModels,
  resolveModelPath,
} from 'react-native-sherpa-onnx';
import { initializeSTT } from 'react-native-sherpa-onnx/stt';
import { initializeTTS } from 'react-native-sherpa-onnx/tts';

// 1) List bundled model folders (each entry has folder + hint: 'stt' | 'tts' | 'unknown')
const models = await listAssetModels();
const sttFolders = models.filter((m) => m.hint === 'stt').map((m) => m.folder);
const ttsFolders = models.filter((m) => m.hint === 'tts').map((m) => m.folder);

// 2) User picks a folder, e.g. 'sherpa-onnx-whisper-tiny-en'
const assetPath = `models/${selectedFolder}`;
const absolutePath = await resolveModelPath({ type: 'asset', path: assetPath });

// 3) Initialize (auto-detect type from files in that folder)
await initializeSTT({
  modelPath: { type: 'asset', path: assetPath },
  modelType: 'auto',
});
// or for TTS:
await initializeTTS({
  modelPath: { type: 'asset', path: assetPath },
  modelType: 'auto',
});
```

Use this when models are **bundled in the app** (main app assets on Android, or folder references in the Xcode project on iOS).

---

## Quick usage: Play Asset Delivery (PAD)

On Android, large models can live in a **separate asset pack** (e.g. `sherpa_models`) so the base APK stays small. The pack is installed with the app; at runtime you get its path and list/load models from there.

### Example file tree

```
# Asset pack module: e.g. android/sherpa_models/
sherpa_models/
  src/main/assets/
    models/
      sherpa-onnx-whisper-tiny-en/
        encoder.onnx
        decoder.onnx
        tokens.txt
      vits-piper-en_US-lessac-low/
        model.onnx
        tokens.txt
```

The app references the pack via `assetPacks = [":sherpa_models"]` and gets the unpacked path with `getAssetPackPath("sherpa_models")`.

### Typical code flow

1. **Get** the PAD models directory with `getAssetPackPath("sherpa_models")` (or a fallback path if not using PAD).
2. **List** model folders under that path with `listModelsAtPath(padPath)`.
3. **Build** the full path for the chosen folder: e.g. `${padPath}/${selectedFolder}` and use `{ type: 'file', path }` (or a small helper that combines base path + folder).
4. **Initialize** STT/TTS with that path.

```typescript
import RNFS from 'react-native-fs';
import {
  getAssetPackPath,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import { initializeTTS } from 'react-native-sherpa-onnx/tts';

const PAD_PACK = 'sherpa_models';

// 1) PAD path (null if app wasn't installed with the asset pack)
const padPath = await getAssetPackPath(PAD_PACK);
const basePath = padPath ?? `${RNFS.DocumentDirectoryPath}/models`;

// 2) List model folders under that path (hint: 'stt' | 'tts' | 'unknown')
const models = await listModelsAtPath(basePath);
const ttsModels = models.filter((m) => m.hint === 'tts').map((m) => m.folder);

// 3) User picks a folder, e.g. 'vits-piper-en_US-lessac-low'
const fullPath = `${basePath.replace(/\/+$/, '')}/${selectedFolder}`;

// 4) Initialize with file path
await initializeTTS({
  modelPath: { type: 'file', path: fullPath },
  modelType: 'auto',
});
```

Use **`listModelsAtPath(path)`** whenever models are **not** in the main app assets: PAD unpack directory, `DocumentDirectoryPath`, or any other filesystem path. Use **`listAssetModels()`** only for models bundled in the main app assets.

---

## Public API for model discovery and paths

| API | Asset | PAD | When to use | Description |
|-----|:-----:|:---:|-------------|-------------|
| **`listAssetModels()`** | ✅ | ❌ | Models are **bundled in the app** (main assets). | Returns model folders under the platform asset `models` directory. Each item has `folder` and `hint` (`'stt' \| 'tts' \| 'unknown'`). Use for listing what’s inside the APK/IPA assets. |
| **`listModelsAtPath(path, recursive?)`** | ❌ | ✅ | Models are on the **filesystem**: PAD unpack path, `DocumentDirectoryPath`, or custom dir. | Lists model folders under the given path. Set `recursive: true` to scan subdirectories. Use for PAD, downloaded models, or any file-based model root. |
| **`getAssetPackPath(packName)`** | ❌ | ✅ | **Android PAD only.** | Returns the path to the asset pack’s content (e.g. the `models` directory inside the pack), or `null` if the pack isn’t available. Use `"sherpa_models"` for the example app’s pack. On iOS returns `null`. |
| **`resolveModelPath(config)`** | ✅ | ✅ | Before initializing STT/TTS with asset or file config. | Converts `{ type: 'asset', path }` or `{ type: 'file', path }` to the absolute path used by native code. Call this when you need the resolved path, or pass the config directly to `initializeSTT` / `initializeTTS`. |
| **`assetModelPath(assetPath)`** | ✅ | ❌ | Building config for **bundled** models. | Returns `{ type: 'asset', path: assetPath }`. Use with paths like `models/sherpa-onnx-whisper-tiny-en`. |
| **`fileModelPath(filePath)`** | ❌ | ✅ | Building config for **filesystem** models. | Returns `{ type: 'file', path: filePath }`. Use with an absolute path to a model folder (e.g. PAD path + folder, or `DocumentDirectoryPath/models/...`). |
| **`autoModelPath(path)`** | ✅ | ✅ | Let the SDK try asset then file. | Returns `{ type: 'auto', path }`. Resolution tries asset first, then file system. |
| **`getDefaultModelPath()`** | ❌ | ✅ | Optional helper for a default root. | Returns a platform-specific default model directory name (e.g. for building paths in app code, PAD fallback). |

**Summary:** Use **`listAssetModels()`** for bundled assets; use **`listModelsAtPath(path)`** for PAD or any filesystem model directory. Then pass the chosen folder to `resolveModelPath` (for assets) or build a file path (for PAD/filesystem) and initialize with that config.

---

## Advanced

### Path resolution and initialization

- **Asset paths** are relative to the app’s asset root (e.g. `models/whisper-tiny`). Always use a consistent prefix (e.g. `models/`) so `listAssetModels()` and your asset path config match.
- **File paths** must be **absolute**. For PAD, use the string returned by `getAssetPackPath()` (plus the chosen folder). For downloads, use e.g. `RNFS.DocumentDirectoryPath + '/sherpa-onnx/models/...'`.
- You can pass `modelPath: { type: 'asset', path }` or `modelPath: { type: 'file', path }` directly to `initializeSTT` / `initializeTTS`; they resolve internally. Use `resolveModelPath()` only when you need the absolute path in JS (e.g. for logging or custom logic).

### Combining bundled and PAD/file models

To show both bundled and PAD (or file-based) models in one list, call both:

- `listAssetModels()` for bundled models.
- `listModelsAtPath(padPath)` (or another root) for PAD/file models.

Merge the two lists in your UI (e.g. tag the source so you know whether to use `assetModelPath` or `fileModelPath` when the user selects a model).

### Download API and local paths

For models **downloaded in-app** with the download API (`react-native-sherpa-onnx/download`):

- Use `getLocalModelPathByCategory(category, id)` to get the local directory path.
- Pass that path as `modelPath: { type: 'file', path: localPath }` to `initializeSTT` / `initializeTTS`.
- To list what’s already downloaded, use `listDownloadedModelsByCategory(category)` from the download module; to list by filesystem path, use `listModelsAtPath(downloadRoot)` if you have a single root for downloads.

### PAD: debug with Metro and release

- **Debug with PAD:** Build and install via the bundle (e.g. `yarn android:pad` or `installDebugWithPad`) so the asset pack is installed; then `getAssetPackPath("sherpa_models")` returns the path. Start Metro and use `adb reverse tcp:8081 tcp:8081` so the app can load JS from Metro.
- **Release:** Build an AAB and upload to Play (or test with bundletool). The pack is delivered with the app; no Metro. See the example app’s Android build for `assetPacks` and bundletool usage.

### Edge cases

- **Empty or unknown hint:** `listAssetModels()` and `listModelsAtPath()` return `hint: 'unknown'` when the folder doesn’t match known STT/TTS file patterns. You can still pass the folder to initialization with `modelType: 'auto'`; the native side will detect the type from the files.
- **Case and naming:** Auto-detection is based on **file names** (e.g. `encoder.onnx`, `tokens.txt`). Folder names are irrelevant. Keep file names as expected by sherpa-onnx (see root README for each model type).
- **Int8 / quantization:** If both full and int8 versions exist (e.g. `model.onnx` and `model.int8.onnx`), the library chooses according to `preferInt8` in the init options. No need to change paths.

---

## Troubleshooting

### "Model directory does not exist"

- **Bundled:** Check the asset path (e.g. `models/your-folder`) and that the folder is actually in the app’s assets (Android: `assets/models/`; iOS: folder reference in the app target, Copy Bundle Resources).
- **PAD:** Ensure the app was installed with the asset pack (e.g. via `installDebugWithPad` or the release AAB). If not, `getAssetPackPath()` is `null` and you must use a fallback path (e.g. `DocumentDirectoryPath`) and put models there.
- **File:** Ensure the path is absolute and the folder exists on disk (e.g. after download or extraction).

### "Cannot auto-detect model type" / initialization fails

- Ensure the folder contains the required files for at least one model type (see [Supported Model Types](../../README.md#supported-model-types) in the README). File names are case-sensitive.
- Try passing an explicit `modelType` (e.g. `'whisper'`, `'vits'`) if you know the type.
- Check that no required file is missing (e.g. `tokens.txt`, or all of `encoder.onnx` / `decoder.onnx` / `joiner.onnx` for transducer).

### `getAssetPackPath("sherpa_models")` returns `null`

- The app was not installed from a bundle that includes the `sherpa_models` asset pack. Install via the AAB (e.g. `yarn android:pad` or the release AAB with bundletool). Plain `installDebug` does not include the pack.

### List is empty or missing models

- **Bundled:** Verify assets are in the right place and that the app was rebuilt after adding models. For Android, ensure the path is under `assets/` (e.g. `assets/models/`).
- **PAD:** Confirm `getAssetPackPath()` returns a non-null path and that you pass that path to `listModelsAtPath()`. Ensure the pack’s `models/` directory contains the expected folders.
- **File:** Ensure the path passed to `listModelsAtPath()` is the **directory that directly contains** model folders (each folder is one model). Use `recursive: true` only if your layout has nested model folders.

### Android: bundletool not found (PAD)

- Add `bundletool` to `PATH`, or pass `-Pbundletool=C:\path\to\bundletool` (Windows) to the Gradle task.

### iOS: framework or headers not found

- Run `pod install` in the app’s `ios` directory. Ensure the sherpa-onnx XCFramework is downloaded (see root README iOS section). If you built the framework locally, place it in `ios/Frameworks/sherpa_onnx.xcframework`.

### Audio format (STT) or playback (TTS)

- STT expects WAV, 16 kHz, mono, 16-bit PCM. Convert with e.g. `ffmpeg -i in.mp3 -ar 16000 -ac 1 -sample_fmt s16 out.wav`.
- TTS returns float samples and sample rate; use the returned sample rate for playback or when writing WAV.

---

## See also

- [STT API](./stt.md) and [TTS API](./tts.md) for initialization options and usage.
- [Model Download Manager](./download-manager.md) for downloading models in-app and cache/registry APIs.
- Root [README](../../README.md) for supported model types and file requirements.
