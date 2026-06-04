# Model Setup

Discover, resolve, and validate model paths across bundled assets, on-demand ship packs (PAD / ODR), and downloaded models.

**Import paths:** path helpers (`bundledModelFileSource`, `listAssetModels`, …) live in `react-native-sherpa-onnx/utils`. The **`FileSource`** type is exported from **`react-native-sherpa-onnx/fileio`**.

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [Path Helpers](#path-helpers)
  - [Asset Discovery](#asset-discovery)
  - [On-demand packs (PAD / ODR)](#on-demand-packs-pad--odr)
  - [Model Detection](#model-detection)
  - [Model detection internals](#model-detection-internals)
- [SDK init bridge (create* vs initialize*)](#sdk-init-bridge)
- [Model Sources at a Glance](#model-sources-at-a-glance)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| Bundled model path | ✅ | `bundledModelFileSource()` — Android `apkAsset`, iOS `appBundle` |
| Multi-source fallback | ✅ | `kind: 'auto'` + explicit `tryOrder` (model detect/init only) |
| Asset listing | ✅ | `listAssetModels()` — scans `assets/models/` (Android) / bundle `models/` (iOS) |
| Filesystem listing | ✅ | `listModelsAtPath()` — scans any directory |
| PAD / ODR ship packs | ✅ | [model-delivery-pad-odr.md](./model-delivery-pad-odr.md) (install-time, on-demand, …); `{ kind: 'pad' }` FileSource **Android only** |
| STT model detection | ✅ | `detectSttModel()` — file-based type detection + required-file validation |
| TTS model detection | ✅ | `detectTtsModel()` — file-based type detection |

---

## Quick start

```typescript
import {
  bundledModelFileSource,
  listAssetModels,
} from 'react-native-sherpa-onnx/utils';
import { detectSttModel, createSTT } from 'react-native-sherpa-onnx/stt';

// 1) Discover bundled models
const models = await listAssetModels();
// [{ folder: 'sherpa-onnx-whisper-tiny-en', hint: 'stt' }, ...]

// 2) Detect model type before loading (FileSource)
const detection = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/model' });
console.log(detection.modelType);    // 'whisper'
console.log(detection.isStreaming);   // false (whisper is offline-only)

// 3) Create engine
const modelSource = bundledModelFileSource('models/sherpa-onnx-whisper-tiny-en');
const stt = await createSTT({
  modelSource,
  modelType: 'auto', // uses detected type
});
```

---

## API reference

### Path Helpers

#### `bundledModelFileSource(relativePath)`

Create a {@link FileSource} for models shipped inside the app package. Resolution is deterministic per platform:

```ts
function bundledModelFileSource(relativePath: string): FileSource;
// Android: { kind: 'app', base: 'apkAsset', path }
// iOS:     { kind: 'app', base: 'appBundle', path }
```

**Android:** relative to `assets/` (e.g. `'models/sherpa-onnx-whisper-tiny-en'`). Materialized to a readable directory under the app sandbox.

**iOS:** relative to the main app bundle (Copy Bundle Resources in Xcode).

Use `{ kind: 'fs', path: absolutePath }` for downloaded or extracted models on disk.

#### `autoModelFileSource(path, tryOrder)` / `kind: 'auto'`

When a model folder name is the same across bundled assets, sandbox, PAD, and/or an absolute path, you can probe multiple locations **in a fixed order** instead of hardcoding one `FileSource` per platform.

```ts
import { autoModelFileSource } from 'react-native-sherpa-onnx/utils';
import { createSTT } from 'react-native-sherpa-onnx/stt';

// Equivalent to:
// { kind: 'auto', path: 'models/my-pack', tryOrder: [...] }
const modelSource = autoModelFileSource('models/my-pack', [
  'apkAsset',   // Android APK assets/models/my-pack
  'appBundle',  // iOS bundle models/my-pack (skipped on Android)
  'files',      // app sandbox files/models/my-pack
  { pad: 'sherpa_models' }, // Android PAD pack (skipped on iOS)
  'fs',         // treat path as absolute FS directory (useful after download/extract)
]);

const stt = await createSTT({ modelSource, modelType: 'auto' });
```

**Rules:**

| Rule | Detail |
| --- | --- |
| **`tryOrder` required** | `{ kind: 'auto', path, tryOrder: [] }` or missing `tryOrder` → `FILEIO_INVALID_ARGUMENT` |
| **Explicit order only** | First target that resolves to an **existing directory** wins; no hidden defaults |
| **Same `path` string** | Relative for `app` / `pad` / bundled bases; absolute when `'fs'` is tried |
| **Platform skips** | Unsupported targets (e.g. `appBundle` on Android) are skipped; resolution continues |
| **Failure** | If nothing matches → `FILEIO_NOT_FOUND` with `tryOrder` and per-target errors in the message |
| **Scope** | Model detect/init (`detectSttModel`, `createSTT`, …) — **not** `copyFile` / `shareFile` |

**Typical Android try order:** `['apkAsset', 'files', { pad: 'sherpa_models' }, 'fs']`  
**Typical iOS try order:** `['appBundle', 'files', 'fs']`

Prefer **`bundledModelFileSource()`** when you know the model is shipped in the app package — it stays fully deterministic without probing.

#### Bundled bases (`apkAsset` vs `appBundle`)

| `AppBaseDir` | Android | iOS |
| --- | --- | --- |
| `apkAsset` | APK `assets/<path>` | `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `appBundle` | `FILEIO_UNSUPPORTED_ON_PLATFORM` | Main bundle `<path>` |
| `files`, `cache`, … | App sandbox only | App sandbox only — **no** bundle fallback |

`pad` (`FileSource`) is Android-only; on iOS use [model-delivery-pad-odr.md](./model-delivery-pad-odr.md) (`fetchAssetPack` / `getAssetPackPath`) then `{ kind: 'fs', path }` for extracted models.

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

### On-demand packs (PAD / ODR)

**PAD & ODR delivery** (install-time, fast-follow, on-demand, iOS bundle) is documented in **[model-delivery-pad-odr.md](./model-delivery-pad-odr.md)** (`fetchAssetPack`, `waitForAssetPackReady`, `getAssetPackState`, `removeAssetPack`).

#### `getAssetPackPath(packName)`

Returns the path to the `models` directory inside an installed pack or downloaded ODR tag, or `null` if not available yet.

```ts
function getAssetPackPath(packName: string): Promise<string | null>;
```

| Platform | `packName` | Notes |
| --- | --- | --- |
| Android | PAD pack name (e.g. `core_models`) | STORAGE_FILES path when pack is on disk; `null` until fetched for on-demand packs |
| iOS | ODR tag (e.g. `core_models`) | `<bundle>/<tag>/models` after `fetchAssetPack` / ODR completes |

Alias: `getPlayAssetDeliveryModelsPath` (same function).

After fetch, list **uncompressed** folders with `listModelsAtPath`, or **compressed** archives via [extraction.md](./extraction.md) (`getBundledArchives` on Android, `listBundledArchives(packPath)` on iOS).

```typescript
const packPath = await getAssetPackPath('core_models');
if (packPath) {
  const models = await listModelsAtPath(packPath, true);
  console.log('Ship pack models:', models);
}
```

---

### Model Detection

Cross-feature unified detection (`detectModel`, batch, QNN): [model-detect.md](model-detect.md). The APIs below are STT/TTS-specific.

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

For `FileSource` resolution problems (unsupported location kind/platform, traversal, permissions, path resolution), the promise can reject with `FILEIO_*` errors before native model detection runs.

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
  lexiconLanguages?: Array<{ id: string; path: string }>;
  /** Always `true` for TTS models. */
  isStreaming: boolean;
}>;
```

Returns `success: false` when required files are missing or validation fails; use **`error`** for the user-facing message when present.

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors (for example `FILEIO_UNSUPPORTED_ON_PLATFORM`, `FILEIO_PATH_TRAVERSAL_BLOCKED`, `FILEIO_PERMISSION_DENIED`, `FILEIO_NOT_FOUND`, `FILEIO_RESOLVE_ERROR`).

`lexiconLanguages` lists detected lexicon files (`id` + absolute `path`) for vits, matcha, kokoro, and zipvoice. Pass `lexiconLanguageId` to `createTTS` to select one; re-init to change. Not the same as catalog `languages` hints.

### Model detection internals

Native code scans the **resolved** model directory (recursive), maps filenames to engine roles, then (a) lists **every** engine kind that *could* fit --> `detectedModels`, and (b) picks based on the highest probability **one** kind for validation --> `modelType` (same rules as `createSTT` / `createTTS` with `modelType: 'auto'`). Full pipeline: comments at the top of `sherpa-onnx-model-detect-stt.cpp` / `sherpa-onnx-model-detect-tts.cpp`.

**Why `detectSttModel` / `detectTtsModel` if `createSTT` / `createTTS` already support `modelType: 'auto'`?**  
Detection is a **cheap preflight**: no recognizer / TTS engine allocation, faster when probing many folders, and you get **`success` / `error` / `isHardwareSpecificUnsupported`** (STT) before paying for full init. Use it for validation UI, model pickers, and diagnostics; skip it if you only need to load one known-good pack.

**STT — return shape, options, and matching `createSTT`:**

```typescript
import { assetModelPath } from 'react-native-sherpa-onnx/utils';
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
  await createSTT({ modelSource: modelPath, modelType: 'auto', preferInt8: true });
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
// det.detectedModels. detectTtsModel is still useful for cheap checks + lexiconLanguages.
// Multi-lexicon packs: use lexiconLanguages for a dropdown; pass id via createTTS({ lexiconLanguageId: 'zh' }).
const lexicons = det.lexiconLanguages;
```

---

## SDK init bridge

Public factories (`createTTS`, `createSTT`, `createStreamingSTT`) use typed options. Native TurboModule methods take a single flat options map per instance: `initializeTts`, `initializeStt`, `initializeOnlineStt` (no positional-arg overloads, no `*WithOptions` suffix).

See [sdk-init-bridge.md](./sdk-init-bridge.md) for the two-layer pattern, bridge type names, and mapping builders.

---

## Model Sources at a Glance

| Source | Path Helper | Discovery | Use Case |
| --- | --- | --- | --- |
| Bundled assets | `bundledModelFileSource()` | `listAssetModels()` | Ship models with the app |
| Multi-source probe | `autoModelFileSource(path, tryOrder)` | — | Same folder name in bundle, sandbox, PAD, or FS |
| PAD / ODR ship | [guide](./model-delivery-pad-odr.md): install-time → `getBundledArchives`; on-demand → `fetchAssetPack` | `extractArchive()` | Tiered or bundled ship archives |
| PAD `FileSource` (installed pack) | `{ kind: 'pad', … }` or `auto` `{ pad: … }` | `getAssetPackPath()` + `listModelsAtPath()` | Android only — read/copy from pack without re-download API |
| Downloaded models | `{ kind: 'fs', path }` | Download Manager or `listModelsAtPath()` | User-selected models at runtime |

`app:files`, `app:apkAsset`, and `app:appBundle` have different semantics and must not be mixed:

| FileSource | Meaning | Platform |
| --- | --- | --- |
| `{ kind: 'app', base: 'files', path: 'models/foo' }` | App sandbox internal files directory | Both |
| `{ kind: 'app', base: 'apkAsset', path: 'models/foo' }` | Bundled APK asset tree | Android only |
| `{ kind: 'app', base: 'appBundle', path: 'models/foo' }` | Main bundle resources | iOS only |
| `{ kind: 'auto', path: 'models/foo', tryOrder: ['apkAsset', 'files', …] }` | Try locations in order; first existing directory | Detect/init only |

Combining multiple sources:

```typescript
import {
  assetModelPath,
  fileModelPath,
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import { getLocalModelPathByCategory, listDownloadedModelsByCategory, ModelCategory } from 'react-native-sherpa-onnx/download';

// Bundled
const bundled = await listAssetModels();

// On-demand pack (Android PAD or iOS ODR tag) — fetch first; see model-delivery-pad-odr.md
const packPath = await getAssetPackPath('core_models');
const packModels = packPath ? await listModelsAtPath(packPath, true) : [];

// Downloaded
const downloaded = await listDownloadedModelsByCategory(ModelCategory.Stt);
```

---

## Detailed Examples

### Auto-detect and init the first available STT model

```typescript
import { assetModelPath, listAssetModels } from 'react-native-sherpa-onnx/utils';
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';

const models = await listAssetModels();
const sttModels = models.filter((m) => m.hint === 'stt');

for (const m of sttModels) {
  const mp = assetModelPath(`models/${m.folder}`);
  const detection = await detectSttModel(mp, { preferInt8: true });
  if (detection.success) {
    const stt = await createSTT({ modelSource: mp, modelType: 'auto', preferInt8: true });
    return stt;
  }
}
throw new Error('No valid STT model found');
```

### On-demand pack — uncompressed models

Requires `fetchAssetPack` / `waitForAssetPackReady` first ([model-delivery-pad-odr.md](./model-delivery-pad-odr.md)).

```typescript
const packPath = await getAssetPackPath('core_models');
if (!packPath) throw new Error('Pack/tag not available');

const models = await listModelsAtPath(packPath, true);
const sttFolder = models.find((m) => m.hint === 'stt');

if (sttFolder) {
  const fullPath = `${packPath}/${sttFolder.folder}`;
  const stt = await createSTT({
    modelSource: fileModelPath(fullPath),
    modelType: 'auto',
  });
}
```

For `.tar.zst` ship archives, extract to a sandbox directory and use `{ kind: 'fs', path }` there — see [extraction.md](./extraction.md) and the quick start in [model-delivery-pad-odr.md](./model-delivery-pad-odr.md).

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
| Bundled model resolution fails | Check that the model directory exists at the expected location on the platform; use `bundledModelFileSource('models/...')` with `app:apkAsset` (Android) or `app:appBundle` (iOS) |
| `getAssetPackPath` returns `null` | On-demand: run `fetchAssetPack` + `waitForAssetPackReady` ([model-delivery-pad-odr.md](./model-delivery-pad-odr.md)); check pack/tag name and native Gradle/Xcode setup |
| `detectSttModel` says missing files | The model directory doesn't contain all required files for the detected type; check the [STT doc](stt-offline.md#validation-required-files) for the file-per-type table |
| Int8 model not found | Set `preferInt8: true` and ensure `*-int8.onnx` variants are present |
| Wrong `hint` value | `hint` is a best-effort heuristic based on folder naming; use `detectSttModel`/`detectTtsModel` for definitive type detection |
| TTS init fails with `Error processing file '/usr/share/espeak-ng-data/phontab'` | Path to `espeak-ng-data` is too long; espeak-ng truncates it and falls back to `/usr/share`. See [issue: TTS espeak-ng path length](../third_party/sherpa-onnx-prebuilt/issue-tts-espeak-ng-path-length.md) for workarounds. |

**Tips:**

- Use `listAssetModels()` for discovery, then `detectSttModel()`/`detectTtsModel()` for accurate type detection — the `hint` is based on naming heuristics only
- Always prefer `modelType: 'auto'` with `detectSttModel()`/`detectTtsModel()` rather than hardcoding model types
- Combine bundled assets, on-demand packs, and downloads into a single model picker by merging all sources

---

## See also

- [Ship model delivery (PAD & ODR)](model-delivery-pad-odr.md) — install-time, fast-follow, on-demand, bundle
- [Extraction API](extraction.md) — `getBundledArchives`, `listBundledArchives`, `extractArchive` for compressed ship archives
- [STT](stt-offline.md) — Speech-to-Text API
- [TTS](tts-offline.md) — Text-to-Speech API
- [SDK init bridge](sdk-init-bridge.md) — `create*` public API vs `initialize*` TurboModule maps
- [Download Manager](download-manager.md) — Download models in-app
- [Execution Providers](execution-providers.md) — QNN, NNAPI, XNNPACK, Core ML
- [Issue: TTS espeak-ng path length](../third_party/sherpa-onnx-prebuilt/issue-tts-espeak-ng-path-length.md) — When TTS init fails due to long `data_dir` path (phontab /usr/share error)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

