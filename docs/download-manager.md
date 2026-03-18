# Model Download Manager

Fetch, cache, and manage model assets from official sherpa-onnx GitHub Releases. Supports archive models (`.tar.bz2`, `.tar.zst`) and single-file models (`.onnx`), with checksum verification and progress events.

**Import path:** `react-native-sherpa-onnx/download`

---

## Recommended: one function for everything

**`ensureModelByCategory(category, id, opts?)`** is the main entry point for most apps. You pass category, model id, and optional callbacks; the function takes care of:

- Returning immediately if the model is already downloaded and extracted
- Resuming an incomplete **extraction** (e.g. after app crash during extract)
- Resuming an incomplete **download** (e.g. after app close during download)
- Starting **extraction only** if the archive is already present (e.g. from PAD or a previous run)
- Starting a **full download** otherwise

So a single call handles download + extraction and all edge cases. Use this when you only need “make this model ready”. The lower-level APIs (`downloadModelByCategory`, `resumeDownload`, `extractModelByCategory`, `getIncompleteExtractions`, `resumeExtraction`, etc.) remain public for advanced flows where you want to control each step yourself.

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Setup (iOS & Android)](#setup-ios--android)
- [API Reference](#api-reference)
  - [Registry & Listing](#registry--listing)
  - [Download & Delete](#download--delete)
  - [Progress & Events](#progress--events)
  - [Metadata & Housekeeping](#metadata--housekeeping)
  - [Validation Helpers](#validation-helpers)
  - [Types & Constants](#types--constants)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| **One-call prepare** | ✅ | **`ensureModelByCategory()`** — download + extract + resume; use this as the main API |
| Fetch model registry | ✅ | `refreshModelsByCategory()` — from GitHub Releases |
| List available models | ✅ | `listModelsByCategory()` — cached registry |
| Download model | ✅ | `downloadModelByCategory()` — with progress, retry, cancellation |
| Extraction (standalone) | ✅ | `extractModelByCategory()`, `getIncompleteExtractions()`, `resumeExtraction()` |
| Checksum verification | ✅ | SHA-256 during extraction or after download |
| Local path for init | ✅ | `getLocalModelPathByCategory()` |
| Delete model | ✅ | `deleteModelByCategory()` |
| Progress events | ✅ | `subscribeDownloadProgress()` — speed, ETA, phase |
| Parallel extraction | ✅ | Support for multiple concurrent model extractions |
| Crash recovery | ✅ | Persistent state for interrupted downloads/extractions; `ensureModelByCategory` resumes automatically |
| List update events | ✅ | `subscribeModelsListUpdated()` |
| LRU cleanup | ✅ | `cleanupLeastRecentlyUsed()` |

**Supported categories:** `Tts`, `Stt`, `Vad`, `Diarization`, `Enhancement`, `Separation`, `Qnn`.

The **Qnn** category uses the [asr-models-qnn-binary](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models-qnn-binary) release for QNN-capable Android devices (e.g. SM8850, SM8550). iOS has no QNN support.

---

## Quick Start

```typescript
import {
  ModelCategory,
  refreshModelsByCategory,
  ensureModelByCategory,
} from 'react-native-sherpa-onnx/download';
import { createTTS } from 'react-native-sherpa-onnx/tts';

// 1) Refresh model registry
await refreshModelsByCategory(ModelCategory.Tts, { forceRefresh: true });

// 2) Ensure model is available (download + extract if needed; resumes if interrupted)
const { modelId, localPath } = await ensureModelByCategory(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium',
  {
    onProgress: (p) => console.log(p.percent, p.phase),
  }
);

const tts = await createTTS({
  modelPath: { type: 'file', path: localPath },
  modelType: 'auto',
});
```

---

## Setup (iOS & Android)

Model downloads use [@kesha-antonov/react-native-background-downloader](https://github.com/kesha-antonov/react-native-background-downloader), which is included as a dependency of this SDK. No extra package install is required.

**Android:** The SDK declares MMKV (`com.tencent:mmkv-shared:1.3.16`) for the background downloader. Do **not** add MMKV again in your app’s `build.gradle`; a duplicate or different merge order can shift resource package IDs and cause a white screen on startup (“No package ID 6a found for resource ID”). If you see that error after updating, do a full clean: `cd android && ./gradlew clean && rm -rf .gradle app/build && cd ..`, then rebuild.

**iOS:** For downloads to complete reliably when the app is in the background or after it was terminated, you must forward the background URL session completion to the downloader in your AppDelegate. Without this, downloads only work reliably while the app is in the foreground.

1. **React Native 0.77+ (Swift)**  
   In your bridging header (e.g. `ios/YourApp-Bridging-Header.h`):
   ```objc
   #import <RNBackgroundDownloader.h>
   ```
   In your `AppDelegate.swift`, add:
   ```swift
   func application(
     _ application: UIApplication,
     handleEventsForBackgroundURLSession identifier: String,
     completionHandler: @escaping () -> Void
   ) {
     RNBackgroundDownloader.setCompletionHandlerWithIdentifier(identifier, completionHandler: completionHandler)
   }
   ```

2. **React Native &lt; 0.77 (Objective-C)**  
   In your `AppDelegate.m`:
   ```objc
   #import <RNBackgroundDownloader.h>

   - (void)application:(UIApplication *)application handleEventsForBackgroundURLSession:(NSString *)identifier completionHandler:(void (^)(void))completionHandler
   {
     [RNBackgroundDownloader setCompletionHandlerWithIdentifier:identifier completionHandler:completionHandler];
   }
   ```

**Expo:** Use the library’s [Expo config plugin](https://github.com/kesha-antonov/react-native-background-downloader#expo-projects); it adds the AppDelegate code automatically at prebuild.

---

## API Reference

### Main API (recommended)

#### `ensureModelByCategory(category, id, options?)`

Ensures the model is available locally. Handles: already ready, incomplete extraction, incomplete download, archive present (extract only), or full download. Returns `{ modelId, localPath }`. Use this when you only need “make this model ready”; the functions below are for advanced control.

**Options:** `onProgress`, `signal`, `overwrite`, `onChecksumIssue`, `deleteArchiveAfterExtract` (same semantics as download/extraction APIs).

```typescript
const { localPath } = await ensureModelByCategory(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny',
  { onProgress: (p) => setPercent(p.percent) }
);
```

---

### Registry & Listing

#### `refreshModelsByCategory(category, options?)`

Fetch and cache the latest model list from GitHub Releases. Call before showing the models UI.

```typescript
await refreshModelsByCategory(ModelCategory.Stt, { forceRefresh: true });
```

#### `listModelsByCategory(category)`

Return the cached model list. Returns empty array if no cache exists yet.

```typescript
const models = await listModelsByCategory<TtsModelMeta>(ModelCategory.Tts);
```

#### `getModelByIdByCategory(category, id)`

Return metadata for a specific model ID.

#### `getModelsCacheStatusByCategory(category)`

Return the last update timestamp for the cached registry.

---

### Download & Delete

The main API **`ensureModelByCategory`** uses these internally. Use them directly only if you need fine-grained control (e.g. start download and extraction in separate steps).

#### `downloadModelByCategory(category, id, options?)`

Download a model by ID. Supports progress callbacks, cancellation, and retries.

**Options:**

- `onProgress?: (progress: DownloadProgress) => void` — Progress callback (percent, phase, speed, eta).
- `overwrite?: boolean` — If true, replace existing download.
- `signal?: AbortSignal` — AbortController signal to cancel the download.
- `maxRetries?: number` — Retry count for failed requests (default: 2).
- `onChecksumIssue?: (issue: ChecksumIssue) => Promise<boolean>` — Called on checksum mismatch; return true to keep the file.
- `deleteArchiveAfterExtract?: boolean` — For archive models (e.g. `.tar.bz2`): if **true** (default), the archive is deleted after successful extraction to save disk space. Set to **false** to keep the archive file.

```typescript
await downloadModelByCategory(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny', {
  onProgress: (progress) => {
    console.log(progress.percent, progress.speed, progress.eta);
  },
});
```

#### `getLocalModelPathByCategory(category, id)`

Get the local path of a downloaded model for initialization.

```typescript
const localPath = await getLocalModelPathByCategory(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

#### `listDownloadedModelsByCategory(category)`

Return only models that are already downloaded on this device.

#### `isModelDownloadedByCategory(category, id)`

Check whether a model is downloaded.

#### `deleteModelByCategory(category, id)`

Remove a downloaded model and its cached files.

```typescript
await deleteModelByCategory(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

#### `clearModelCacheByCategory(category)`

Clear the cached registry for a category.

---

### Crash Recovery & Resumption

**`ensureModelByCategory`** automatically resumes incomplete downloads and incomplete extractions when you call it. The APIs below are for advanced use (e.g. showing a list of “in progress” items or letting the user cancel a specific one).

The download manager uses persistent state files (`.download-state-<modelId>.json` for downloads, `.extraction-state-<modelId>.json` for extractions). If the app crashes or is killed, these APIs let you find and resume or delete them.

#### Download resumption

#### `getIncompleteDownloads(category)`

Find all interrupted **downloads** (and post-download extractions that never started). Returns an array of `DownloadState` objects.

```typescript
const interrupted = await getIncompleteDownloads(ModelCategory.Stt);
for (const state of interrupted) {
  console.log(`Phase: ${state.phase}, started at: ${state.startedAt}`);
}
```

#### `resumeDownload(category, id, options?)`

Resume an interrupted download. When the archive is already fully downloaded, this runs extraction.

```typescript
await resumeDownload(ModelCategory.Stt, 'whisper-tiny');
```

#### `deleteIncompleteDownload(category, id)`

Clean up a partial download: removes partial model dir, partial archive, and download state file.

```typescript
await deleteIncompleteDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

#### Extraction resumption

#### `getIncompleteExtractions(category)`

Find all interrupted **extractions** (archive was complete but extraction did not finish). Returns an array of `ExtractionState` objects.

```typescript
const incomplete = await getIncompleteExtractions(ModelCategory.Stt);
```

#### `resumeExtraction(category, id, options?)`

Resume an incomplete extraction (e.g. after app restart). Re-extracts from the existing archive.

```typescript
await resumeExtraction(ModelCategory.Stt, 'whisper-tiny');
```

#### `extractModelByCategory(category, id, options?)`

Start extraction when the archive is already present (e.g. from PAD or a previous download). Fails if the archive is missing or truncated.

#### `deleteIncompleteExtraction(category, id)`

Remove extraction state and partial model dir; keeps the archive so the user can retry.

---

### Progress & Events

#### `subscribeDownloadProgress(listener)`

Subscribe to download progress updates. Returns an unsubscribe function.

```typescript
import { subscribeDownloadProgress } from 'react-native-sherpa-onnx/download';

const unsubscribe = subscribeDownloadProgress((category, modelId, progress) => {
  // progress.bytesDownloaded, progress.totalBytes, progress.percent
  // progress.phase: 'downloading' | 'extracting'
  // progress.speed (bytes/sec), progress.eta (seconds)
  console.log(category, modelId, progress.percent);
});

// Call unsubscribe() when no longer needed
```

#### `subscribeModelsListUpdated(listener)`

Subscribe to model list refresh events. Returns an unsubscribe function.

```typescript
const unsubscribe = subscribeModelsListUpdated((category, models) => {
  console.log('Updated:', category, models.length);
});
```

---

### Metadata & Housekeeping

#### `getDownloadStorageBase()`

Get the base storage directory for downloads.

#### `updateModelLastUsed(category, id)`

Update a model's last-used timestamp (for LRU cleanup).

#### `listDownloadedModelsWithMetadata(category)`

List downloaded models with metadata: `downloadedAt`, `lastUsed`, `sizeOnDisk`.

```typescript
const items = await listDownloadedModelsWithMetadata(ModelCategory.Stt);
// items[0]: { model, downloadedAt, lastUsed, sizeOnDisk }
```

#### `cleanupLeastRecentlyUsed(category, options?)`

Remove least recently used models to free disk space.

---

### Validation Helpers

Public helpers from `react-native-sherpa-onnx/download`. Most apps only need the high-level download API.

| Function | Description |
| --- | --- |
| `validateChecksum(filePath, expected)` | Validate a file's SHA-256 checksum |
| `validateExtractedFiles(dir, expected)` | Verify extracted files match expectations |
| `checkDiskSpace(requiredBytes)` | Check available disk space |
| `setExpectedFilesForCategory(category, files)` | Set expected files for validation |
| `getExpectedFilesForCategory(category)` | Get expected files |
| `parseChecksumFile(content)` | Parse a checksum.txt file |
| `calculateFileChecksum(filePath)` | Calculate SHA-256 of a file |
| `extractTarBz2(archivePath, destDir, options?)` | Extract a .tar.bz2 archive |
| `extractTarZst(archivePath, destDir, options?)` | Extract a .tar.zst / .zst archive |

---

### Types & Constants

```ts
import {
  ModelCategory,
  ensureModelByCategory,
  refreshModelsByCategory,
  listModelsByCategory,
  downloadModelByCategory,
  getLocalModelPathByCategory,
  listDownloadedModelsByCategory,
  isModelDownloadedByCategory,
  getModelByIdByCategory,
  deleteModelByCategory,
  clearModelCacheByCategory,
  getDownloadStorageBase,
  subscribeDownloadProgress,
  subscribeModelsListUpdated,
  updateModelLastUsed,
  listDownloadedModelsWithMetadata,
  cleanupLeastRecentlyUsed,
  getIncompleteDownloads,
  resumeDownload,
  deleteIncompleteDownload,
  getIncompleteExtractions,
  resumeExtraction,
  extractModelByCategory,
  deleteIncompleteExtraction,
  getModelsCacheStatusByCategory,
} from 'react-native-sherpa-onnx/download';

import type {
  ModelMetaBase,
  TtsModelMeta,
  TtsModelType,
  Quantization,
  SizeTier,
  DownloadProgress,
  DownloadProgressListener,
  ModelsListUpdatedListener,
  DownloadResult,
  DownloadState,
  ExtractionState,
  ModelWithMetadata,
  EnsureModelOptions,
} from 'react-native-sherpa-onnx/download';
```

**`ModelCategory` enum:**

| Value | Description |
| --- | --- |
| `Tts` | Text-to-Speech models |
| `Stt` | Speech-to-Text models |
| `Vad` | Voice Activity Detection models |
| `Diarization` | Speaker diarization models |
| `Enhancement` | Audio enhancement models |
| `Separation` | Audio separation models |
| `Qnn` | QNN (Qualcomm NPU) ASR models |

**`DownloadProgress`:**

| Field | Type | Description |
| --- | --- | --- |
| `bytesDownloaded` | `number` | Bytes downloaded so far |
| `totalBytes` | `number` | Total size |
| `percent` | `number` | 0..100 |
| `phase` | `'downloading' \| 'extracting'` | Current phase |
| `speed` | `number` | Bytes/second |
| `eta` | `number` | Estimated seconds remaining |

**`DownloadState`:**

| Field | Type | Description |
| --- | --- | --- |
| `modelId` | `string` | ID of the model |
| `category` | `ModelCategory` | Model category |
| `phase` | `'downloading' \| 'extracting'` | Current phase when interrupted |
| `startedAt` | `string` | ISO timestamp of start |
| `archivePath`| `string` | Local path to the archive file |
| `model` | `ModelMetaBase` | Original model metadata |
| `bytesDownloaded` | `number?` | Progress info (if available) |
| `totalBytes` | `number?` | Total bytes |

**`ExtractionState`:** Same shape as `DownloadState` for extraction-only state; includes `modelDir`. Used by `getIncompleteExtractions()`.

**`EnsureModelOptions`:** `onProgress`, `signal`, `overwrite`, `onChecksumIssue`, `deleteArchiveAfterExtract`.

---

## Detailed Examples

### Ensure model with progress UI (recommended)

```typescript
import {
  ModelCategory,
  refreshModelsByCategory,
  ensureModelByCategory,
} from 'react-native-sherpa-onnx/download';

await refreshModelsByCategory(ModelCategory.Stt);
const { localPath } = await ensureModelByCategory(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny',
  {
    onProgress: (p) => {
      updateProgressBar(p.percent);
      setPhaseLabel(p.phase === 'downloading' ? 'Downloading…' : 'Extracting…');
    },
  }
);
```

### Download with progress (lower-level)

```typescript
import {
  ModelCategory,
  refreshModelsByCategory,
  downloadModelByCategory,
  subscribeDownloadProgress,
} from 'react-native-sherpa-onnx/download';

const unsub = subscribeDownloadProgress((cat, id, progress) => {
  updateProgressBar(progress.percent);
  setSpeedLabel(`${(progress.speed / 1024).toFixed(0)} KB/s`);
  setEtaLabel(`${progress.eta?.toFixed(0)}s`);
});

await refreshModelsByCategory(ModelCategory.Stt);
await downloadModelByCategory(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
unsub();
```

### List downloaded models with metadata

```typescript
import {
  ModelCategory,
  listDownloadedModelsWithMetadata,
} from 'react-native-sherpa-onnx/download';

const items = await listDownloadedModelsWithMetadata(ModelCategory.Stt);
for (const { model, downloadedAt, lastUsed, sizeOnDisk } of items) {
  console.log(model.displayName, sizeOnDisk, lastUsed);
}
```

### Cleanup old models

```typescript
import { ModelCategory, cleanupLeastRecentlyUsed } from 'react-native-sherpa-onnx/download';

await cleanupLeastRecentlyUsed(ModelCategory.Stt);
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| Empty model list | Call `refreshModelsByCategory()` with `forceRefresh: true` first |
| Download fails | Check network connectivity; the download manager retries automatically |
| Checksum mismatch | Re-download the model; delete and retry |
| Disk space error | Use `checkDiskSpace()` before downloading; or `cleanupLeastRecentlyUsed()` |
| QNN models on iOS | QNN category is Android-only; use `Stt`/`Tts` categories on iOS |
| Path is null after download | Ensure download completed successfully; check with `isModelDownloadedByCategory()` |

**Checksums:**
- Archives: validated using native hashing during extraction
- Single-file models (`.onnx`): validated with local SHA-256
- When `checksum.txt` doesn't list a file, the GitHub asset digest is used if available

---

## See Also

- [Model Setup](model-setup.md) — Model discovery, paths, and detection
- [STT](stt.md) — Speech-to-Text API
- [TTS](tts.md) — Text-to-Speech API
- [Execution Providers](execution-providers.md) — QNN, NNAPI, XNNPACK, Core ML
