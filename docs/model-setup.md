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
  - [Model detection internals](#model-detection-internals)
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
| PAD support | ✅ | See [Extraction API](extraction.md) for more details - Android only |
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
import { detectSttModel } from 'react-native-sherpa-onnx/stt';

// 1) Discover bundled models
const models = await listAssetModels();
// [{ folder: 'sherpa-onnx-whisper-tiny-en', hint: 'stt' }, ...]

// 2) Detect model type before loading (FileSource)
const detection = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/model' });
console.log(detection.modelType);    // 'whisper'
console.log(detection.isStreaming);   // false (whisper is offline-only)

// 3) Create engine
const modelPath = assetModelPath('models/sherpa-onnx-whisper-tiny-en');
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

#### `detectSttModel(source, options?)`

Detect the STT model type and validate required files without loading the model.

```ts
function detectSttModel(
  source: FileSource,
  options?: { preferInt8?: boolean; modelType?: STTModelType }
): Promise<{
  success: boolean;
  /** When `success` is `false`: native validation/detect message. Omitted if the native layer returned an empty string. */
  error?: string;
  /** Unsupported-hardware model (e.g. RK35xx, Ascend); from native when applicable. */
  isHardwareSpecificUnsupported?: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  /** `true` when the detected model type is a streaming-capable online engine (transducer, paraformer, zipformer2_ctc, nemo_ctc, tone_ctc). */
  isStreaming: boolean;
}>;
```

Returns `success: false` when required files are missing or validation fails; use **`error`** for the user-facing message when present.

#### `detectTtsModel(source, options?)`

Detect the TTS model type without loading.

```ts
function detectTtsModel(
  source: FileSource,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  /** When `success` is `false`: native validation/detect message. Omitted if the native layer returned an empty string. */
  error?: string;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  lexiconLanguageCandidates?: string[];
  /** Always `true` for TTS models. */
  isStreaming: boolean;
}>;
```

Returns `success: false` when required files are missing or validation fails; use **`error`** for the user-facing message when present.

`lexiconLanguageCandidates` is present for Kokoro/Kitten models — contains language IDs from detected lexicon files (e.g. `"us-en"`, `"zh"`).

### Model detection internals

Native code scans the **resolved** model directory (recursive), maps filenames to engine roles, then (a) lists **every** engine kind that *could* fit --> `detectedModels`, and (b) picks based on the highest probability **one** kind for validation --> `modelType` (same rules as `createSTT` / `createTTS` with `modelType: 'auto'`). Full pipeline: comments at the top of `sherpa-onnx-model-detect-stt.cpp` / `sherpa-onnx-model-detect-tts.cpp`.

**Why `detectSttModel` / `detectTtsModel` if `createSTT` / `createTTS` already support `modelType: 'auto'`?**  
Detection is a **cheap preflight**: no recognizer / TTS engine allocation, faster when probing many folders, and you get **`success` / `error` / `isHardwareSpecificUnsupported`** (STT) before paying for full init. Use it for validation UI, model pickers, and diagnostics; skip it if you only need to load one known-good pack.

**STT — return shape, options, and matching `createSTT`:**

```typescript
import { assetModelPath } from 'react-native-sherpa-onnx';
import { detectSttModel, createSTT } from 'react-native-sherpa-onnx/stt';

const modelPath = assetModelPath('models/my-pack');
// detectSttModel resolves the FileSource internally, then runs native file scan (no recognizer init).

const det = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/my-pack' }, {
  // preferInt8 omitted: do not filter by int8 in filenames (native picks among matches by its own rule).
  // preferInt8: true  --> use int8-named ONNX where applicable (e.g. *-int8.onnx).
  // preferInt8: false --> skip int8-named ONNX files (float / full-precision variants).
  preferInt8: true,

  // modelType omitted or 'auto': choose kind from folder-name hints, else fixed fallback order.
  // modelType: 'whisper' | 'nemo_transducer' | … --> use only if that engine is supported by the files.
  modelType: 'auto',
});

// Array = all engine types this folder might represent (often length 1). Same modelDir per entry;
// multiple entries = ambiguous pack — e.g. build a picker from det.detectedModels.map(m => m.type).
const candidates = det.detectedModels;

// Kind native used for validation (informative). Usually you do NOT pass this into createSTT — see below.
const chosen = det.modelType;

if (!det.success) {
  console.error(det.error, det.isHardwareSpecificUnsupported); // wrong/missing files or unsupported HW pack
} else {
  // Same preferInt8 as detectSttModel so the same ONNX files are chosen for init.
  //
  // Prefer modelType: 'auto' here (not det.modelType): createSTT re-runs the same native auto-selection
  // on this path + preferInt8, so behavior stays one code path and matches future heuristic changes.
  // Pass an explicit modelType only when the user overrides auto, e.g. picked from det.detectedModels.
  await createSTT({ modelPath, modelType: 'auto', preferInt8: true });
}
```

**TTS — same split (`detectedModels` vs `modelType`) plus lexicon languages:**

```typescript
import { detectTtsModel, createTTS } from 'react-native-sherpa-onnx/tts';

const det = await detectTtsModel({ kind: 'fs', path: '/absolute/path/to/tts-pack' }, {
  // 'auto' vs 'vits' | 'matcha' | 'kokoro' | 'kitten' | 'pocket' | 'zipvoice' — same idea as STT.
  modelType: 'auto',
});

// Same pattern as STT: use modelType: 'auto' on createTTS unless the user picked a candidate from
// det.detectedModels. detectTtsModel is still useful for cheap checks + lexiconLanguageCandidates.
// Kokoro/Kitten: optional language ids from lexicon files for a dropdown (e.g. "us-en", "zh", "default").
const langs = det.lexiconLanguageCandidates;
```

---

## Model Sources at a Glance

| Source | Path Helper | Discovery | Use Case |
| --- | --- | --- | --- |
| Bundled assets | `assetModelPath()` | `listAssetModels()` | Ship models with the app |
| Play Asset Delivery | `fileModelPath()` | `getAssetPackPath()` + `listModelsAtPath()` | Large models on Android (on-demand packs) |
| PAD compressed archives | — | `getBundledArchives()` + `extractArchive()` from `react-native-sherpa-onnx/extraction` | PAD packs with .tar.zst/.tar.bz2; extract to a dir then use `listModelsAtPath` + `autoModelPath` |
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
| `detectSttModel` says missing files | The model directory doesn't contain all required files for the detected type; check the [STT doc](stt-offline.md#validation-required-files) for the file-per-type table |
| Int8 model not found | Set `preferInt8: true` and ensure `*-int8.onnx` variants are present |
| Wrong `hint` value | `hint` is a best-effort heuristic based on folder naming; use `detectSttModel`/`detectTtsModel` for definitive type detection |
| TTS init fails with `Error processing file '/usr/share/espeak-ng-data/phontab'` | Path to `espeak-ng-data` is too long; espeak-ng truncates it and falls back to `/usr/share`. See [issue: TTS espeak-ng path length](../third_party/sherpa-onnx-prebuilt/issue-tts-espeak-ng-path-length.md) for workarounds. |

**Tips:**

- Use `listAssetModels()` for discovery, then `detectSttModel()`/`detectTtsModel()` for accurate type detection — the `hint` is based on naming heuristics only
- Always prefer `modelType: 'auto'` with `detectSttModel()`/`detectTtsModel()` rather than hardcoding model types
- Combine bundled assets, PAD, and downloads into a single model picker by merging all sources

---

## See Also

- [Extraction API](extraction.md) — `getBundledArchives`, `listBundledArchives`, `extractArchive` for PAD or bundle .tar.zst/.tar.bz2
- [STT](stt-offline.md) — Speech-to-Text API
- [TTS](tts.md) — Text-to-Speech API
- [Download Manager](download-manager.md) — Download models in-app
- [Execution Providers](execution-providers.md) — QNN, NNAPI, XNNPACK, Core ML
- [Issue: TTS espeak-ng path length](../third_party/sherpa-onnx-prebuilt/issue-tts-espeak-ng-path-length.md) — When TTS init fails due to long `data_dir` path (phontab /usr/share error)
