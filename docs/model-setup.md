# Model Setup

Discover, resolve, and validate model paths across bundled assets, Play Asset Delivery (PAD), and downloaded models.

**Import path:** `react-native-sherpa-onnx`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [Path Helpers](#path-helpers)
  - [Asset Discovery](#asset-discovery)
  - [Play Asset Delivery (PAD)](#play-asset-delivery-pad)
  - [Model Detection](#model-detection)
- [Model Sources at a Glance](#model-sources-at-a-glance)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| Asset model path | ✅ | `assetModelPath()` — bundled in app |
| File model path | ✅ | `fileModelPath()` — absolute filesystem path |
| Auto model path | ✅ | `autoModelPath()` — tries asset then filesystem |
| Path resolution | ✅ | `resolveModelPath()` — returns native-usable absolute path |
| Asset listing | ✅ | `listAssetModels()` — scans `assets/models/` (Android) / bundle `models/` (iOS) |
| Filesystem listing | ✅ | `listModelsAtPath()` — scans any directory |
| PAD support | ✅ | `getAssetPackPath()` — Android only |
| STT model detection | ✅ | `detectSttModel()` — file-based type detection + required-file validation |
| TTS model detection | ✅ | `detectTtsModel()` — file-based type detection |

---

## Quick Start

```typescript
import {
  assetModelPath,
  listAssetModels,
  resolveModelPath,
} from 'react-native-sherpa-onnx';
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';

// 1) Discover bundled models
const models = await listAssetModels();
// [{ folder: 'sherpa-onnx-whisper-tiny-en', hint: 'stt' }, ...]

// 2) Detect model type before loading
const modelPath = assetModelPath('models/sherpa-onnx-whisper-tiny-en');
const detection = await detectSttModel(modelPath);
console.log(detection.modelType); // 'whisper'

// 3) Create engine
const stt = await createSTT({
  modelPath,
  modelType: 'auto', // uses detected type
});
```

---

## API Reference

### Path Helpers

#### `assetModelPath(assetPath)`

Create a `ModelPathConfig` pointing to a model bundled in app assets.

```ts
function assetModelPath(assetPath: string): ModelPathConfig;
// Returns { type: 'asset', path: assetPath }
```

**Android:** relative to `assets/` (e.g. `'models/sherpa-onnx-whisper-tiny-en'`).
**iOS:** relative to the app bundle (e.g. `'models/sherpa-onnx-whisper-tiny-en'`).

#### `fileModelPath(filePath)`

Create a `ModelPathConfig` pointing to a model on the filesystem.

```ts
function fileModelPath(filePath: string): ModelPathConfig;
// Returns { type: 'file', path: filePath }
```

Use absolute paths (e.g. from downloads or PAD). On iOS, use the Documents directory path.

#### `autoModelPath(path)`

Create a `ModelPathConfig` that tries asset first, then filesystem.

```ts
function autoModelPath(path: string): ModelPathConfig;
// Returns { type: 'auto', path }
```

#### `resolveModelPath(config)`

Resolve a `ModelPathConfig` to an absolute filesystem path that native code can use.

```ts
function resolveModelPath(config: ModelPathConfig): Promise<string>;
```

| `type` | Resolution |
| --- | --- |
| `'asset'` | Native copies/locates the asset and returns an absolute path |
| `'file'` | Returns the path as-is |
| `'auto'` | Tries asset first; falls back to file |

#### `getDefaultModelPath()`

Returns the platform-specific default model directory.

```ts
function getDefaultModelPath(): string;
// iOS: 'Documents/models'
// Android: 'models'
```

---

### Asset Discovery

#### `listAssetModels()`

Scan the bundled assets model directory and return discovered model folders with a hint.

```ts
function listAssetModels(): Promise<Array<{
  folder: string;
  hint: 'stt' | 'tts' | 'unknown';
}>>;
```

On Android scans `assets/models/`; on iOS scans the `models/` bundle directory.

#### `listModelsAtPath(path, recursive?)`

Scan a filesystem directory for model folders.

```ts
function listModelsAtPath(
  path: string,
  recursive?: boolean
): Promise<Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>>;
```

When `recursive` is `true`, returns relative folder paths under the base path. Useful for listing downloaded or PAD-delivered models.

---

### Play Asset Delivery (PAD)

#### `getAssetPackPath(packName)`

Returns the path to the models directory inside an Android asset pack, or `null` if unavailable (iOS always returns `null`).

```ts
function getAssetPackPath(packName: string): Promise<string | null>;
```

Alias: `getPlayAssetDeliveryModelsPath` (same function).

Use with `listModelsAtPath` to enumerate PAD-delivered models:

```typescript
const padPath = await getAssetPackPath('sherpa_models');
if (padPath) {
  const padModels = await listModelsAtPath(padPath, true);
  console.log('PAD models:', padModels);
}
```

---

### Model Detection

#### `detectSttModel(modelPath, options?)`

Detect the STT model type and validate required files without loading the model.

```ts
function detectSttModel(
  modelPath: ModelPathConfig,
  options?: { preferInt8?: boolean; modelType?: STTModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
}>;
```

Returns `success: false` with an error when required files are missing.

#### `detectTtsModel(modelPath, options?)`

Detect the TTS model type without loading.

```ts
function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  lexiconLanguageCandidates?: string[];
}>;
```

`lexiconLanguageCandidates` is present for Kokoro/Kitten models — contains language IDs from detected lexicon files (e.g. `"us-en"`, `"zh"`).

---

## Model Sources at a Glance

| Source | Path Helper | Discovery | Use Case |
| --- | --- | --- | --- |
| Bundled assets | `assetModelPath()` | `listAssetModels()` | Ship models with the app |
| Play Asset Delivery | `fileModelPath()` | `getAssetPackPath()` + `listModelsAtPath()` | Large models on Android (on-demand packs) |
| Downloaded models | `fileModelPath()` | `listModelsAtPath()` or Download Manager | User-selected models at runtime |
| Fallback / auto | `autoModelPath()` | — | Try asset first, then file |

Combining multiple sources:

```typescript
import {
  listAssetModels,
  getAssetPackPath,
  listModelsAtPath,
  fileModelPath,
  assetModelPath,
} from 'react-native-sherpa-onnx';
import { getLocalModelPathByCategory, listDownloadedModelsByCategory, ModelCategory } from 'react-native-sherpa-onnx/download';

// Bundled
const bundled = await listAssetModels();

// PAD (Android)
const padPath = await getAssetPackPath('sherpa_models');
const padModels = padPath ? await listModelsAtPath(padPath, true) : [];

// Downloaded
const downloaded = await listDownloadedModelsByCategory(ModelCategory.Stt);
```

---

## Detailed Examples

### Auto-detect and init the first available STT model

```typescript
import { listAssetModels, assetModelPath } from 'react-native-sherpa-onnx';
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';

const models = await listAssetModels();
const sttModels = models.filter((m) => m.hint === 'stt');

for (const m of sttModels) {
  const mp = assetModelPath(`models/${m.folder}`);
  const detection = await detectSttModel(mp, { preferInt8: true });
  if (detection.success) {
    const stt = await createSTT({ modelPath: mp, modelType: 'auto', preferInt8: true });
    return stt;
  }
}
throw new Error('No valid STT model found');
```

### PAD model loading with detection

```typescript
const padPath = await getAssetPackPath('sherpa_models');
if (!padPath) throw new Error('Asset pack not available');

const models = await listModelsAtPath(padPath, true);
const sttFolder = models.find((m) => m.hint === 'stt');

if (sttFolder) {
  const fullPath = `${padPath}/${sttFolder.folder}`;
  const stt = await createSTT({
    modelPath: fileModelPath(fullPath),
    modelType: 'auto',
  });
}
```

### Validation: check before init

```typescript
const detection = await detectSttModel(
  assetModelPath('models/my-model'),
  { preferInt8: true }
);

if (!detection.success) {
  // detection contains error info about missing files
  console.error('Model validation failed:', detection);
  return;
}
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| `listAssetModels()` returns empty | Ensure models are in `android/app/src/main/assets/models/` or the iOS bundle `models/` group |
| `resolveModelPath()` fails | Check that the model directory exists at the expected location on the platform |
| PAD returns `null` | PAD requires `play-core` dependency and correct `build.gradle` asset pack config; iOS always returns `null` |
| `detectSttModel` says missing files | The model directory doesn't contain all required files for the detected type; check the [STT doc](stt.md#validation-required-files) for the file-per-type table |
| Int8 model not found | Set `preferInt8: true` and ensure `*-int8.onnx` variants are present |
| Wrong `hint` value | `hint` is a best-effort heuristic based on folder naming; use `detectSttModel`/`detectTtsModel` for definitive type detection |

**Tips:**

- Use `listAssetModels()` for discovery, then `detectSttModel()`/`detectTtsModel()` for accurate type detection — the `hint` is based on naming heuristics only
- Always prefer `modelType: 'auto'` with `detectSttModel()`/`detectTtsModel()` rather than hardcoding model types
- Combine bundled assets, PAD, and downloads into a single model picker by merging all sources

---

## See Also

- [STT](stt.md) — Speech-to-Text API
- [TTS](tts.md) — Text-to-Speech API
- [Download Manager](download-manager.md) — Download models in-app
- [Execution Providers](execution-providers.md) — QNN, NNAPI, XNNPACK, Core ML
