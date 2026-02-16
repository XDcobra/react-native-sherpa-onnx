# Play Asset Delivery (PAD)

This document explains how to use **Play Asset Delivery (PAD)** with react-native-sherpa-onnx so that large model files live in a separate Android asset pack instead of the main APK. It also describes how to build and run the app for **debug (with Metro)** and **release**, and gives a quick API reference for PAD-related APIs.

## What is PAD?

[Play Asset Delivery](https://developer.android.com/guide/playcore/asset-delivery) lets you ship large assets (e.g. sherpa-onnx models) in a separate **asset pack** that is installed alongside your app. Benefits:

- **Smaller base APK** – the main app stays small; models are in the `sherpa_models` pack.
- **Optional delivery** – you can use install-time, fast-follow, or on-demand for the pack.
- The example app uses **install-time** so the pack is always installed with the app.

At runtime, the app gets the path to the unpacked asset pack via the Play Core API and can list and load models from that path.

## Project layout (example app)

- **Asset pack module:** `example/android/sherpa_models/`  
  - `build.gradle` applies `com.android.asset-pack`, `packName = "sherpa_models"`, `deliveryType = "install-time"`.
  - Models go under `sherpa_models/src/main/assets/models/<model-folder>/` (e.g. `vits-piper-en_US-lessac-low/`).
- **App module:** `example/android/app/build.gradle`  
  - Declares `assetPacks = [":sherpa_models"]`.
  - Contains the `installDebugWithPad` and related tasks that build the AAB and install via bundletool for local PAD testing.

Models are downloaded into the pack before build (e.g. via `downloadSherpaModels` or your own script).

## Debug build with Metro (PAD)

To run the app in debug with PAD so that **Metro** is used for the JS bundle and the **asset pack** is installed correctly:

1. **Start Metro** (in the `example` folder):
   ```bash
   cd example
   yarn start
   ```
   Leave this running (Metro at `http://localhost:8081`).

2. **Build and install with PAD** (from repo root or from `example`):
   - From root:
     ```bash
     yarn example android:pad
     ```
   - Or from `example`:
     ```bash
     yarn android:pad
     ```

This runs `react-native run-android --tasks installDebugWithPad`, which:

- Builds the debug AAB (including the `sherpa_models` pack).
- Uses **bundletool** to generate APKs with `--local-testing` and installs them.
- Runs **`adb reverse tcp:8081 tcp:8081`** so the device can reach Metro at `localhost:8081`.

After that, open the app on the device; it will load JS from Metro and models from the PAD pack (or fallback path). `getAssetPackPath("sherpa_models")` will return the pack path when the app was installed via this flow.

**Requirements:** `bundletool` in PATH (or set `-Pbundletool=C:\path\to\bundletool` on Windows). See [Test asset delivery](https://developer.android.com/guide/playcore/asset-delivery/test).

## Release build (PAD)

For release, you build an **Android App Bundle (AAB)** and publish to Play (or test with bundletool):

1. **Build the release bundle:**
   ```bash
   cd example/android
   ./gradlew bundleRelease
   ```
   Output: `app/build/outputs/bundle/release/app-release.aab` (or similar).

2. **Optional – local install with PAD (like debug):**
   ```bash
   bundletool build-apks --bundle=app/build/outputs/bundle/release/app-release.aab --output=app-release.apks --local-testing
   bundletool install-apks --apks=app-release.apks
   ```

3. **Publish:** Upload the AAB to the Play Console. Users get the app and the install-time asset pack together; no Metro involved.

Release builds do not use Metro; the JS bundle is embedded in the AAB.

## API quick reference (PAD and model paths)

These are the main APIs for discovering and loading models when using PAD or file-system model directories.

### Listing models

| API | Description |
|-----|-------------|
| **`listAssetModels()`** | Lists model folders in the **main app assets** (`assets/models/`). Use for models bundled in the APK. |
| **`listModelsAtPath(path, recursive?)`** | Lists model folders under a **filesystem path** (e.g. PAD unpack path or `DocumentDirectoryPath/models`). Use for PAD or downloaded models. |
| **`getAssetPackPath(packName)`** / **`getPlayAssetDeliveryModelsPath(packName)`** | **PAD only.** Returns the path to the `models` directory inside the given Android asset pack, or `null` if the pack is not available. Use `"sherpa_models"` for the example app. |

### Path configuration for loading

| API | Description |
|-----|-------------|
| **`assetModelPath(assetPath)`** | Config for models in app assets (e.g. `models/vits-piper-en`). |
| **`fileModelPath(filePath)`** | Config for a **full absolute path** to a model directory. |
| **`getFileModelPath(modelName, category?, basePath?)`** | Builds a file path: `basePath` or `DocumentDirectoryPath/sherpa-onnx/models/<category>`, then appends `modelName`. Use `basePath` when loading from PAD (pass the path returned by `getAssetPackPath`). |
| **`resolveModelPath(config)`** | Resolves a path config (asset/file/auto) to an **absolute path** used by native code. |

### Typical PAD flow in app code

```ts
import {
  getAssetPackPath,
  getPlayAssetDeliveryModelsPath,
  listModelsAtPath,
  getFileModelPath,
} from 'react-native-sherpa-onnx';

const PAD_PACK = 'sherpa_models';

// 1) Get PAD models directory (or fallback)
const padPath = await getAssetPackPath(PAD_PACK) ?? `${RNFS.DocumentDirectoryPath}/models`;
const padModels = await listModelsAtPath(padPath);
const ttsModels = padModels.filter(m => m.hint === 'tts').map(m => m.folder);

// 2) When user picks a model folder (e.g. 'vits-piper-en_US-lessac-low')
const modelPath = getFileModelPath(selectedFolder, undefined, padPath);

// 3) Initialize TTS with that path
await initializeTTS({ modelPath, ... });
```

For **asset** (bundled) models use `getAssetModelPath(modelFolder)` and `assetModelPath(...)` instead of `getFileModelPath(..., basePath)`.

## Troubleshooting

- **`getAssetPackPath("sherpa_models")` returns `null`**  
  The app was not installed via a bundle that includes the asset pack (e.g. you used a plain `installDebug` APK). Use `yarn android:pad` (or `installDebugWithPad`) so the pack is installed; then PAD path is available.

- **Metro “not running” / red screen after PAD install**  
  Ensure `adb reverse tcp:8081 tcp:8081` was run (the `android:pad` script does this). Start Metro with `yarn start` in `example` before opening the app.

- **App crashes when loading a PAD (or file-system) model**  
  - Ensure the model folder contains all required files (e.g. for VITS: `model.onnx`, `tokens.txt`, and any `espeak-ng-data` if needed).  
  - Capture the full crash: run `adb logcat` **without** filtering by tag to get the native stack trace.  
  - If you use the fallback path (`DocumentDirectoryPath/models`), ensure the folder there has the same structure as in the asset pack.

- **bundletool “command not found” (Windows)**  
  Add bundletool to PATH or pass the path:  
  `./gradlew installDebugWithPad -Pbundletool=C:\path\to\bundletool`

- **Existing `app-debug-pad.apks`**  
  The build deletes the previous output before running bundletool; if you see “file already exists”, ensure you use the updated Gradle setup that deletes it in `buildApksForPad`’s `doFirst`.
