# Model Download Manager

Fetch, cache, and manage model assets from official sherpa-onnx GitHub Releases. Supports archive models (`.tar.bz2`) and single-file models (`.onnx`), with checksum verification and progress events.

**Import path:** `react-native-sherpa-onnx/download`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
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
| Fetch model registry | ✅ | `refreshModelsByCategory()` — from GitHub Releases |
| List available models | ✅ | `listModelsByCategory()` — cached registry |
| Download model | ✅ | `downloadModelByCategory()` — with progress, retry, cancellation |
| Checksum verification | ✅ | SHA-256 during extraction or after download |
| Local path for init | ✅ | `getLocalModelPathByCategory()` |
| Delete model | ✅ | `deleteModelByCategory()` |
| Progress events | ✅ | `subscribeDownloadProgress()` — speed, ETA, phase |
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
  downloadModelByCategory,
  getLocalModelPathByCategory,
} from 'react-native-sherpa-onnx/download';
import { createTTS } from 'react-native-sherpa-onnx/tts';

// 1) Refresh model registry
await refreshModelsByCategory(ModelCategory.Tts, { forceRefresh: true });

// 2) Download a model
await downloadModelByCategory(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');

// 3) Get local path and initialize
const localPath = await getLocalModelPathByCategory(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium'
);

if (localPath) {
  const tts = await createTTS({
    modelPath: { type: 'file', path: localPath },
    modelType: 'auto',
  });
}
```

---

## API Reference

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

#### `downloadModelByCategory(category, id, options?)`

Download a model by ID. Supports progress callbacks, cancellation, and retries.

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

---

### Types & Constants

```ts
import {
  ModelCategory,
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
  ModelWithMetadata,
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

---

## Detailed Examples

### Download with progress UI

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
