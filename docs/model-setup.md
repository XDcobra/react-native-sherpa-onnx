# Model setup

Discover model locations, build `FileSource` descriptors, and list available packs — **before** detection or engine init.

| Doc | Question it answers |
| --- | --- |
| **This page** | Where is my model? How do I point the SDK at it? |
| [model-detect.md](model-detect.md) | What model type is this? Is it valid? How do I init (auto vs custom)? |
| [model-languages.md](model-languages.md) | Which language codes / pickers apply to a model family? |
| [model-delivery-pad-odr.md](model-delivery-pad-odr.md) | How do I ship large models via PAD (Android) or ODR (iOS)? |

**Imports:** path helpers → `react-native-sherpa-onnx/utils` · `FileSource` type → `react-native-sherpa-onnx/fileio`

---

## Table of contents

- [Quick start](#quick-start)
- [FileSource — the common thread](#filesource--the-common-thread)
- [Model sources at a glance](#model-sources-at-a-glance)
- [Expected folder layouts](#expected-folder-layouts)
- [PAD / ODR (large models)](#pad--odr-large-models)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

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
// [{ folder: 'sherpa-onnx-whisper-tiny-en', hint: 'stt' }, …]

// 2) Build a FileSource for the pack you want
const modelSource = bundledModelFileSource('models/sherpa-onnx-whisper-tiny-en');

// 3) Optional cheap pre-check (no engine load) — see model-detect.md
const detection = await detectSttModel(modelSource);
if (!detection.success) throw new Error(detection.error ?? 'Invalid pack');

// 4) Create engine (auto mode — SDK detects type from folder)
const stt = await createSTT({ modelSource, modelType: 'auto' });
```

---

## FileSource — the common thread

Every model path in the SDK is a **`FileSource`** — a small descriptor that tells native code **where** to read files. The same type is used for detection, engine init, alignment, and segmentation policy.

```typescript
type FileSource =
  | { kind: 'fs'; path: string }                              // absolute path on disk
  | { kind: 'app'; base: AppBaseDir; path: string }           // app sandbox or bundled tree
  | { kind: 'contentUri'; uri: string }                       // Android SAF document (Android only)
  | { kind: 'securityScoped'; uri: string }                   // iOS security-scoped URL (iOS only)
  | { kind: 'pad'; packName: string; path: string }            // installed PAD pack (Android only)
  | { kind: 'auto'; path: string; tryOrder: AutoTryTarget[] }; // probe multiple locations
```

| `kind` | Typical use | Platform |
| --- | --- | --- |
| `fs` | Downloaded / extracted models | Both |
| `app` + `apkAsset` | Models in `android/app/src/main/assets/` | Android |
| `app` + `appBundle` | Models in the iOS app bundle (Copy Bundle Resources) | iOS |
| `app` + `files` / `documents` | App sandbox after download or extract | Both |
| `pad` | Read from an **already installed** PAD pack | Android |
| `auto` | Try bundled → sandbox → PAD → fs in order | Detect/init only |

> [!NOTE]
> **`FileSource` describes a location, not a single file.** For auto init you pass a **folder**; native detection scans it. For custom init you pass one `FileSource` **per required file** — see [Init modes](model-detect.md#init-modes-auto-vs-custom) in model-detect.md.

Full `FileSource` / copy / share API: [fileio.md](fileio.md).

### Bundled bases (`apkAsset` vs `appBundle`)

| `AppBaseDir` | Resolves to | Platform |
| --- | --- | --- |
| `apkAsset` | APK `assets/<path>` | Android only |
| `appBundle` | Main bundle `<path>` | iOS only |
| `files`, `cache`, `documents`, … | App sandbox | Both — **no** bundle fallback |

Use **`bundledModelFileSource('models/my-pack')`** when you know the model ships inside the app — it picks the correct base per platform.

---

## Model sources at a glance

| Source | Helper | Discovery | When to use |
| --- | --- | --- | --- |
| **Bundled** | `bundledModelFileSource(path)` | `listAssetModels()` | Small models shipped with the app |
| **Downloaded** | `{ kind: 'fs', path }` | [download-manager.md](download-manager.md) | User downloads at runtime |
| **PAD / ODR** | `getAssetPackPath(pack)` → `listModelsAtPath` | `fetchAssetPack` + `ensureAssetPackReady` | Large tiered ship packs — see [PAD/ODR section](#pad--odr-large-models) |
| **Multi-location** | `autoModelFileSource(path, tryOrder)` | — | Same folder name in bundle, sandbox, and/or PAD |

```typescript
import {
  bundledModelFileSource,
  autoModelFileSource,
  listAssetModels,
  listModelsAtPath,
  getAssetPackPath,
} from 'react-native-sherpa-onnx/utils';
import { listDownloadedModelsByCategory, ModelCategory } from 'react-native-sherpa-onnx/download';

// Bundled
const bundled = await listAssetModels();

// On-demand pack (fetch first — see model-delivery-pad-odr.md)
const packPath = await getAssetPackPath('core_models');
const packModels = packPath ? await listModelsAtPath(packPath, true) : [];

// Downloaded
const downloaded = await listDownloadedModelsByCategory(ModelCategory.Stt);
```

### `kind: 'auto'` — probe multiple locations

When the same folder name may exist in the bundle, sandbox, PAD, or as an absolute path:

```typescript
import { autoModelFileSource } from 'react-native-sherpa-onnx/utils';

const modelSource = autoModelFileSource('models/my-pack', [
  'apkAsset',              // Android APK assets/models/my-pack
  'appBundle',             // iOS bundle models/my-pack (skipped on Android)
  'files',                 // app sandbox files/models/my-pack
  { pad: 'sherpa_models' }, // Android PAD pack (skipped on iOS)
  'fs',                    // treat path as absolute directory
]);
```

| Rule | Detail |
| --- | --- |
| `tryOrder` required | Missing or empty → `FILEIO_INVALID_ARGUMENT` |
| First match wins | First target that resolves to an **existing directory** |
| Platform skips | Unsupported targets (e.g. `appBundle` on Android) are skipped silently |
| Scope | Model detect/init only — **not** `copyFile` / `shareFile` |

Typical Android: `['apkAsset', 'files', { pad: 'sherpa_models' }, 'fs']`  
Typical iOS: `['appBundle', 'files', 'fs']`

Prefer **`bundledModelFileSource()`** when you know the model is in the app package — fully deterministic, no probing.

---

## Expected folder layouts

Auto init expects a **directory** containing the ONNX files and sidecar files for one Sherpa model family. Native detection scans recursively and maps filenames to roles.

### Bundled (`apkAsset` / `appBundle`)

```
assets/models/                          ← Android root (iOS: bundle models/)
└── sherpa-onnx-whisper-tiny-en/        ← one folder = one model pack
    ├── tiny-encoder.onnx
    ├── tiny-decoder.onnx
    └── tiny-tokens.txt
```

```typescript
const source = bundledModelFileSource('models/sherpa-onnx-whisper-tiny-en');
// Android → { kind: 'app', base: 'apkAsset', path: 'models/sherpa-onnx-whisper-tiny-en' }
// iOS     → { kind: 'app', base: 'appBundle', path: 'models/sherpa-onnx-whisper-tiny-en' }
```

### Downloaded / extracted (`fs`)

```
/data/user/0/com.myapp/files/models/
└── sherpa-onnx-streaming-zipformer-en/
    ├── encoder-epoch-99-avg-1.onnx
    ├── decoder-epoch-99-avg-1.onnx
    ├── joiner-epoch-99-avg-1.onnx
    └── tokens.txt
```

```typescript
const source = { kind: 'fs', path: '/data/user/0/com.myapp/files/models/sherpa-onnx-streaming-zipformer-en' };
```

### PAD / ODR pack (after fetch)

Uncompressed folders:

```
…/core_models/models/
└── sherpa-onnx-whisper-tiny-en/
    ├── tiny-encoder.onnx
    ├── tiny-decoder.onnx
    └── tiny-tokens.txt
```

Compressed ship archives (`.tar.zst`):

```
…/core_models/models/
└── studio_models.tar.zst    ← extract first, then use fs path
```

After extract → `{ kind: 'fs', path: '<sandbox>/models/<modelId>' }`. See [extraction.md](extraction.md).

> [!CAUTION]
> **Custom init (`initMode: 'custom'`)** does **not** require a detectable folder layout. You pass explicit `FileSource` per file instead. See [Init modes](model-detect.md#init-modes-auto-vs-custom).

Required files per model type: feature docs (e.g. [STT required files](stt-offline.md#validation-required-files)) and [model-detect.md — Required files](model-detect.md#required-files-per-feature).

---

## PAD / ODR (large models)

For models too large to ship in the main APK/IPA, use **Play Asset Delivery** (Android) or **On-Demand Resources** (iOS). The SDK provides transport APIs; your app orchestrates fetch, extract, and init.

| Step | API | Notes |
| --- | --- | --- |
| Fetch | `fetchAssetPack` / `ensureAssetPackReady` | On-demand packs download at runtime |
| Resolve path | `getAssetPackPath(packName)` | Returns `…/models/` or `null` if not ready |
| List | `listModelsAtPath(packPath)` or `listBundledArchives(packPath)` | Folders vs compressed archives |
| Extract (optional) | `extractArchive(archive, targetDir)` | For `.tar.zst` ship packs |
| Init | `{ kind: 'fs', path: extractedDir }` | Same as any downloaded model |

```typescript
import { ensureAssetPackReady, getAssetPackPath, listModelsAtPath } from 'react-native-sherpa-onnx/utils';

await ensureAssetPackReady('core_models', {
  onProgress: (_state, percent) => console.log('download', percent),
});

const packPath = await getAssetPackPath('core_models');
if (!packPath) throw new Error('Pack not available');

const models = await listModelsAtPath(packPath, true);
// → [{ folder: 'sherpa-onnx-whisper-tiny-en', hint: 'stt' }, …]
```

Full guide: **[model-delivery-pad-odr.md](model-delivery-pad-odr.md)** (delivery modes, native setup, troubleshooting).

---

## API reference

### `bundledModelFileSource(relativePath)`

```typescript
function bundledModelFileSource(relativePath: string): FileSource;
```

```typescript
const source = bundledModelFileSource('models/sherpa-onnx-whisper-tiny-en');
// Android: { kind: 'app', base: 'apkAsset', path: '…' }
// iOS:     { kind: 'app', base: 'appBundle', path: '…' }
```

Returns a platform-correct `FileSource` for models inside the app package. Prefer this over hardcoding `apkAsset` / `appBundle`.

---

### `autoModelFileSource(path, tryOrder)`

```typescript
function autoModelFileSource(
  path: string,
  tryOrder: AutoTryTarget[]
): FileSource;
```

```typescript
const source = autoModelFileSource('models/my-pack', ['apkAsset', 'files', 'fs']);
const stt = await createSTT({ modelSource: source, modelType: 'auto' });
```

Builds `{ kind: 'auto', path, tryOrder }`. First existing directory wins. Detect/init only.

---

### `listAssetModels()`

```typescript
function listAssetModels(): Promise<Array<{
  folder: string;
  hint: 'stt' | 'tts' | 'unknown';
}>>;
```

```typescript
const models = await listAssetModels();
// Android: scans assets/models/ · iOS: scans bundle models/
```

Returns folder names with a best-effort category hint. Use `detect*Model` or `detectModel` for definitive type detection — hints are naming heuristics only.

---

### `listModelsAtPath(path, recursive?)`

```typescript
function listModelsAtPath(
  path: string,
  recursive?: boolean
): Promise<Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>>;
```

```typescript
const packPath = await getAssetPackPath('core_models');
const models = packPath ? await listModelsAtPath(packPath, true) : [];
```

Scans any filesystem directory. `recursive: true` returns relative paths under the base.

---

### `getAssetPackPath(packName)`

```typescript
function getAssetPackPath(packName: string): Promise<string | null>;
```

```typescript
const packPath = await getAssetPackPath('core_models');
// Android: PAD STORAGE_FILES path …/models
// iOS: ODR tag path …/{tag}/models
// null until pack is fetched / ready
```

Returns the `models` directory inside an installed pack. Alias: `getPlayAssetDeliveryModelsPath`.

Fetch workflow: [model-delivery-pad-odr.md](model-delivery-pad-odr.md).

---

## Troubleshooting

| Issue | Solution |
| --- | --- |
| `listAssetModels()` returns empty | Models must be in `android/app/src/main/assets/models/` or iOS bundle `models/` group |
| Bundled resolution fails | Verify folder exists; use `bundledModelFileSource('models/…')` |
| `getAssetPackPath` returns `null` | Run `fetchAssetPack` + `ensureAssetPackReady` first — [model-delivery-pad-odr.md](model-delivery-pad-odr.md) |
| `FILEIO_NOT_FOUND` with `kind: 'auto'` | No location in `tryOrder` matched; check each target path |
| `detect*Model` says missing files | Folder layout doesn't match expected files — see feature [required files](stt-offline.md#validation-required-files) table |
| Wrong `hint` from listing | Hint is naming heuristic only; run feature detect for definitive type |

---

## See also

- [Model detection & init](model-detect.md) — detect, validate, auto vs custom init
- [Ship model delivery (PAD & ODR)](model-delivery-pad-odr.md)
- [Extraction API](extraction.md) — `.tar.zst` / `.tar.bz2` archives
- [Download Manager](download-manager.md) — runtime model downloads
- [File I/O](fileio.md) — `FileSource` shapes, copy/share
- [SDK init bridge](sdk-init-bridge.md) — `create*` vs native `initialize*` maps
