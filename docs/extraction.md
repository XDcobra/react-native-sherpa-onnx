# Extraction API (Compressed Archives)

The `react-native-sherpa-onnx/extraction` subpath provides a unified API to **list** and **extract** compressed model archives (`.tar.zst` and `.tar.bz2`). After extraction to a target directory (e.g. `DocumentDirectoryPath/models`), use `listModelsAtPath` and `autoModelPath` from the main package to discover and use the extracted models.

---

## Table of Contents

- [When to use](#when-to-use)
- [Normal assets vs. PAD assets](#normal-assets-vs-pad-assets)
- [API Reference](#api-reference)
  - [`getBundledArchives`](#getbundledarchivespackname)
  - [`listBundledArchives`](#listbundledarchivesdirectorypath)
  - [`extractArchive`](#extractarchivearchive-targetpath-options)
  - [`Types`](#types)
- [Function overview table](#function-overview-table)
- [Path expectations table](#path-expectations-table)
- [Examples](#examples)
  - [PAD compressed archives (Android)](#1-pad-compressed-archives-android)
  - [iOS main bundle archives](#2-ios-main-bundle-archives)
  - [Non-PAD compressed archives (any platform)](#3-non-pad-compressed-archives-any-platform)
- [Workflow: from archive to model init](#workflow-from-archive-to-model-init)
- [See also](#see-also)

---

## When to use

Use this API whenever your models are delivered as **compressed archives** (`.tar.zst` or `.tar.bz2`) that need to be extracted before the native sherpa-onnx engine can use them. Common scenarios:

| Scenario | Function | Platform |
| --- | --- | --- |
| Android PAD pack with compressed archives | `getBundledArchives` | Android only |
| iOS main-bundle archives | `listBundledArchives` | iOS (and Android) |
| Archives downloaded to the filesystem | `listBundledArchives` | Both |
| Extract any of the above | `extractArchive` | Both |
| Parallel extraction | `extractArchive` (concurrent) | Both |

If your models are already extracted (uncompressed folders) — for example plain PAD packs or bundled assets — you do **not** need this API. Use the path helpers from the [main package](model-setup.md) directly.

---

## Normal assets vs. PAD assets

Understanding the distinction helps when reading the API, but **you never need to handle the difference yourself** — `extractArchive` does it automatically.

| | Normal (filesystem) archive | PAD APK_ASSETS archive |
| --- | --- | --- |
| **Where it lives** | On the filesystem — iOS bundle, Documents dir, PAD `STORAGE_FILES`, or any directory | Embedded inside the APK (Android only) |
| **How you list it** | `listBundledArchives(directoryPath)` | `getBundledArchives(packName)` (falls back to asset listing automatically) |
| **`fromAsset`** | `undefined` / absent | `true` |
| **`archivePath`** | Absolute filesystem path (e.g. `/data/.../whisper.tar.zst`) | Asset path (e.g. `models/whisper.tar.zst`) — pack content is merged at app asset root |
| **`fileSize`** | Available (from `stat`) | Not available (0 or absent) |
| **Extraction method** | Native reads from filesystem path | Native streams from Android `AssetManager` — no temp copy |
| **Platform** | iOS + Android | Android only |

### How `getBundledArchives` resolves the source automatically

```
getBundledArchives("sherpa_models")
  │
  ├─ getAssetPackPath returns a path?  →  STORAGE_FILES
  │    └─ scanDirectoryForArchives(path)  →  BundledArchive[] (filesystem)
  │
  └─ getAssetPackPath returns null?    →  APK_ASSETS
       └─ listBundledArchiveAssetPaths  →  BundledArchive[] (fromAsset: true, archivePath: "models/…")
```

For **APK_ASSETS**, the pack’s `src/main/assets/models/` content is merged into the app’s asset root, so the canonical path is **`models`** (same for Play Store and bundletool install-time delivery).

---

## API Reference

Import from the extraction subpath:

```typescript
import {
  getBundledArchives,
  listBundledArchives,
  extractArchive,
  type BundledArchive,
  type ExtractArchiveOptions,
  type ExtractResult,
  type ExtractProgressEvent,
} from 'react-native-sherpa-onnx/extraction';
```

### getBundledArchives(packName)

```ts
function getBundledArchives(packName: string): Promise<BundledArchive[] | null>
```

**Android only.** Returns the list of `.tar.zst` and `.tar.bz2` archives in the given Play Asset Delivery pack.

- When the pack is **STORAGE_FILES**, scans the pack directory on the filesystem.
- When the pack is **APK_ASSETS**, lists archives at asset path `models` (pack content is merged at app asset root). Archives are returned with `fromAsset: true` and `archivePath` like `models/name.tar.zst`.
- Returns `null` on **iOS** or when the pack is not available / empty.

### listBundledArchives(directoryPath)

```ts
function listBundledArchives(directoryPath: string): Promise<BundledArchive[]>
```

Lists `.tar.zst` and `.tar.bz2` files in the given filesystem directory. **Cross-platform.** Use for:

- iOS main-bundle archives (`MainBundlePath + '/models'`)
- Archives downloaded to the documents directory
- PAD STORAGE_FILES path (if you prefer calling `getAssetPackPath` yourself)
- Any other folder

Returns an empty array when the directory does not exist or contains no matching archives.

### extractArchive(archive, targetPath, options?)

```ts
function extractArchive(
  archive: BundledArchive,
  targetPath: string,
  options?: ExtractArchiveOptions
): Promise<ExtractResult>
```

Extracts one archive into `targetPath`. Handles both source types transparently:

- **Filesystem archives** → regular path-based extraction via native `extractTarZst` / `extractTarBz2`.
- **APK asset archives** (`fromAsset: true`) → streams from the APK via `extractTarZstFromAsset` / `extractTarBz2FromAsset` (no temp copy).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `force` | `boolean` | `true` | Overwrite existing files in `targetPath` |
| `onProgress` | `(event) => void` | — | Callback with `{ bytes, totalBytes, percent }`. Correctly handles parallel extractions by filtering by source path. |
| `signal` | `AbortSignal` | — | Cancel extraction (throws `AbortError`). Cancellation is **per-operation**, so cancelling one archive won't affect others. |

**Note on Parallelism:**
- **Android:** Supports up to **2 concurrent extractions** via a fixed thread pool. Additional requests are queued.
- **iOS:** Supports multiple concurrent extractions via GCD.
- **Cancellation:** Aborting a specific `AbortSignal` only cancels that specific extraction.

### Types

```ts
type BundledArchive = {
  modelId: string;       // derived from filename (e.g. "whisper-tiny" from "whisper-tiny.tar.zst")
  archivePath: string;   // filesystem path or asset path (APK_ASSETS: "models/name.tar.zst")
  format: 'tar.zst' | 'tar.bz2';
  fileSize?: number;     // bytes (filesystem only)
  fromAsset?: boolean;   // true for APK_ASSETS archives
};

type ExtractArchiveOptions = {
  force?: boolean;
  onProgress?: (event: ExtractProgressEvent) => void;
  signal?: AbortSignal;
};

type ExtractResult = {
  success: boolean;
  path?: string;    // extracted directory
  sha256?: string;  // source archive digest
  reason?: string;  // error description
};

type ExtractProgressEvent = {
  bytes: number;
  totalBytes: number;
  percent: number;       // 0–100
};
```

---

## Function overview table

| Function | Input | Returns | Platform | Use case |
| --- | --- | --- | --- | --- |
| `getBundledArchives(packName)` | PAD pack name | `BundledArchive[] \| null` | Android | List archives in a PAD pack (STORAGE_FILES or APK_ASSETS) |
| `listBundledArchives(dirPath)` | Absolute directory path | `BundledArchive[]` | iOS + Android | List archives in any filesystem directory |
| `extractArchive(archive, target)` | `BundledArchive` + target dir | `ExtractResult` | iOS + Android | Extract a single archive (any source) |

---

## Path expectations table

| Source | How to list | `archivePath` format | `fromAsset` | `fileSize` | Extraction path |
| --- | --- | --- | --- | --- | --- |
| **PAD STORAGE_FILES** | `getBundledArchives("pack")` | Absolute filesystem path | absent | ✅ | `extractTarZst` / `extractTarBz2` (path) |
| **PAD APK_ASSETS** | `getBundledArchives("pack")` | `models/name.tar.zst` (app asset root) | `true` | ❌ | `extractTarZstFromAsset` / `extractTarBz2FromAsset` (stream) |
| **iOS main bundle** | `listBundledArchives(MainBundlePath + '/models')` | Absolute filesystem path | absent | ✅ | `extractTarZst` / `extractTarBz2` (path) |
| **Downloaded archive** | `listBundledArchives(DocumentDirectoryPath + '/downloads')` | Absolute filesystem path | absent | ✅ | `extractTarZst` / `extractTarBz2` (path) |
| **Any other directory** | `listBundledArchives(path)` | Absolute filesystem path | absent | ✅ | `extractTarZst` / `extractTarBz2` (path) |

> The consumer never needs to pick the extraction method — `extractArchive` reads `fromAsset` and `archivePath` to choose the correct native call automatically.

---

## Examples

### 1. PAD compressed archives (Android)

```typescript
import { getBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { listModelsAtPath, autoModelPath } from 'react-native-sherpa-onnx';

const targetDir = `${DocumentDirectoryPath}/models`;

// List archives from PAD pack (STORAGE_FILES or APK_ASSETS — handled automatically)
const archives = await getBundledArchives('sherpa_models');
if (archives?.length) {
  for (const archive of archives) {
    await extractArchive(archive, targetDir, {
      onProgress: (e) => console.log(archive.modelId, `${e.percent}%`),
    });
  }
}

// Discover extracted models
const models = await listModelsAtPath(targetDir, true);
// → [{ folder: 'whisper-tiny', hint: 'stt' }, ...]
```

### 2. iOS main bundle archives

```typescript
import { listBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { MainBundlePath, DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

const bundleDir = `${MainBundlePath}/models`;
const targetDir = `${DocumentDirectoryPath}/models`;

const archives = await listBundledArchives(bundleDir);
for (const archive of archives) {
  await extractArchive(archive, targetDir, { force: false });
}
```

### 3. Non-PAD compressed archives (any platform)

If your app ships or downloads `.tar.zst` / `.tar.bz2` archives **outside** of Play Asset Delivery — for example archives bundled in the Android `assets/` folder, copied from the iOS bundle, or downloaded via the network — use `listBundledArchives` to discover them and `extractArchive` to extract.

```typescript
import { listBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { listModelsAtPath, fileModelPath } from 'react-native-sherpa-onnx';
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';

// Suppose you downloaded model archives to a "downloads" folder
const downloadsDir = `${DocumentDirectoryPath}/downloads`;
const modelsDir = `${DocumentDirectoryPath}/models`;

const archives = await listBundledArchives(downloadsDir);
// → [{ modelId: 'whisper-tiny-en', archivePath: '/.../whisper-tiny-en.tar.zst', format: 'tar.zst', fileSize: 41230000 }]

for (const archive of archives) {
  const result = await extractArchive(archive, modelsDir, {
    force: false, // skip if already extracted
    onProgress: (e) => console.log(archive.modelId, `${e.percent}%`),
  });
  console.log('Extracted to:', result.path);
}

// Use the extracted models
const models = await listModelsAtPath(modelsDir, true);
const sttModel = models.find((m) => m.hint === 'stt');
if (sttModel) {
  const mp = fileModelPath(`${modelsDir}/${sttModel.folder}`);
  const detection = await detectSttModel(mp);
  if (detection.success) {
    const stt = await createSTT({ modelPath: mp, modelType: 'auto' });
    // ready to transcribe
  }
}
```

---

## Workflow: from archive to model init

```
 ┌─────────────────────┐     ┌────────────────────┐     ┌─────────────────────┐
 │  List archives       │     │  Extract            │     │  Use models          │
 │                      │     │                     │     │                      │
 │ getBundledArchives() │────▶│ extractArchive()    │────▶│ listModelsAtPath()   │
 │ listBundledArchives()│     │   (handles PAD +    │     │ autoModelPath()      │
 │                      │     │    filesystem)       │     │ createSTT / TTS()    │
 └─────────────────────┘     └────────────────────┘     └─────────────────────┘
```

1. **List** — get `BundledArchive[]` descriptors for your archives
2. **Extract** — extract each archive to a shared models directory
3. **Use** — discover the resulting model folders and initialize engines

---

## See also

- [Model setup](model-setup.md) — path helpers, `getAssetPackPath`, `listModelsAtPath`, `autoModelPath`
- [Download manager](download-manager.md) — downloading models from the network
- [STT](stt.md) — Speech-to-Text API
- [TTS](tts.md) — Text-to-Speech API
