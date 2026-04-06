# Download Manager

Unified model download and extraction API for public SDK usage.

**Import path:** `react-native-sherpa-onnx/download`

## Quick Start

### 1) One call: ensure model is ready

```ts
import { ModelCategory, ensureModel, refreshModels } from 'react-native-sherpa-onnx/download';

// Load model list from remote/cache so ids resolve.
await refreshModels(ModelCategory.Stt, { forceRefresh: true });

// Single entry: resumes incomplete download/extract if needed, else downloads + extracts.
const { modelId, localPath } = await ensureModel(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny',
  {
    onProgress: (p) => console.log(p.phase, p.percent),
  }
);
```

### 2) Low-level download with explicit pause/resume

```ts
import {
  ModelCategory,
  downloadModel,
  PauseError,
  pauseDownload,
  resumeDownload,
} from 'react-native-sherpa-onnx/download';

// `run` is a Promise that starts work immediately; it keeps running in parallel.
const run = downloadModel(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium', {
  onProgress: (p) => console.log(p.percent),
});

await pauseDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');

// Await so the first job settles (rejects with PauseError) — avoids unhandled rejection.
try {
  await run;
} catch (error) {
  if (!(error instanceof PauseError)) {
    throw error;
  }
}

await resumeDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

### 3) Extraction-only flow (archive already on disk)

```ts
import {
  ModelCategory,
  extractModel,
  PauseError,
  pauseExtraction,
  resumeExtraction,
} from 'react-native-sherpa-onnx/download';

// Same pattern as download: extraction runs in the background as a Promise.
const extraction = extractModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
await pauseExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');

// Wait for that Promise to finish with PauseError before calling resume.
try {
  await extraction;
} catch (error) {
  if (!(error instanceof PauseError)) {
    throw error;
  }
}

await resumeExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Downloader | **Peer dependency:** `@kesha-antonov/react-native-background-downloader` (^4.5.4). Install it in your app alongside `react-native-sherpa-onnx`; React Native autolinking only picks up native modules from your app’s direct dependencies. |
| Android | Foreground service permissions are merged by dependency |
| Android 13+ | Request `POST_NOTIFICATIONS` at runtime for visible notifications |
| iOS | Forward background URL session completion in AppDelegate |

### Configure background downloader (optional)

```ts
import { configureBackgroundDownloader } from 'react-native-sherpa-onnx/download';

configureBackgroundDownloader({
  showNotificationsEnabled: true,
  notificationsGrouping: {
    enabled: false,
    mode: 'individual',
    texts: {
      downloadTitle: 'Model download',
      downloadStarting: 'Starting...',
      downloadProgress: 'Downloading... {progress}%',
    },
  },
});
```

## API Reference

## High-Level API

### `ensureModel(category, modelId, options?)`

One-call flow: ready check -> resume extraction -> resume download -> extract archive -> download.

```ts
const ready = await ensureModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Registry

### `refreshModels(category, options?)`

Fetches remote release metadata and updates cache.

```ts
await refreshModels(ModelCategory.Tts, { forceRefresh: true });
```

### `listModels(category)`

Reads cached model list for one category.

```ts
const models = await listModels(ModelCategory.Alignment);
```

### `getModelById(category, modelId)`

Returns one model from the cached list or `null`.

```ts
const model = await getModelById(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `getModelsCacheStatus(category)`

Returns cache timestamp metadata.

```ts
const status = await getModelsCacheStatus(ModelCategory.Stt);
```

### `clearModelsCache(category)`

Deletes local cache for a category.

```ts
await clearModelsCache(ModelCategory.Stt);
```

## Download

### `downloadModel(category, modelId, options?)`

Starts model download and post-processing.

```ts
await downloadModel(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium', {
  onProgress: (p) => console.log(p.bytesProcessed, p.totalBytes),
});
```

### `pauseDownload(category, modelId)`

Pauses an active download and keeps partial bytes.

```ts
await pauseDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

### `resumeDownload(category, modelId, options?)`

Resumes a paused or interrupted download.

```ts
await resumeDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

### `getIncompleteDownloads(category)`

Lists paused/interrupted downloads in one category.

```ts
const pending = await getIncompleteDownloads(ModelCategory.Stt);
```

### `deleteIncompleteDownload(category, modelId)`

Removes partial download artifacts and state.

```ts
await deleteIncompleteDownload(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Extraction

### `extractModel(category, modelId, options?)`

Starts extraction from an already available archive.

```ts
await extractModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `pauseExtraction(category, modelId)`

Pauses an active extraction. Resume metadata is persisted in `.extraction-state-<modelId>.json` as described above.

```ts
await pauseExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `resumeExtraction(category, modelId, options?)`

Resumes a paused or interrupted extraction using the saved `.extraction-state-*.json` (including **`lastEntryIndex`** when present) so native extraction resumes with the correct **`skipEntries`**.

```ts
await resumeExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `getIncompleteExtractions(category)`

Lists interrupted extractions in one category.

```ts
const extractionStates = await getIncompleteExtractions(ModelCategory.Stt);
```

### `deleteIncompleteExtraction(category, modelId)`

Removes extraction state and partial output.

```ts
await deleteIncompleteExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Local Models

### `isModelDownloaded(category, modelId)`

Checks if model is fully ready.

```ts
const ready = await isModelDownloaded(ModelCategory.Alignment, 'sherpa-onnx-wav2vec2.0-torchaudio');
```

### `getModelPath(category, modelId)`

Returns resolved local path for model initialization.

```ts
const path = await getModelPath(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `listDownloadedModels(category)`

Lists downloaded models (without runtime status fields).

```ts
const installed = await listDownloadedModels(ModelCategory.Stt);
```

### `listDownloadedModelsWithMetadata(category)`

Lists downloaded models with metadata (`downloadedAt`, `lastUsed`, `sizeOnDisk`, `status`).

```ts
const entries = await listDownloadedModelsWithMetadata(ModelCategory.Stt);
```

### `deleteModel(category, modelId)`

Deletes a fully downloaded model and local artifacts.

```ts
await deleteModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `updateModelLastUsed(category, modelId)`

Updates `lastUsed` timestamp in model manifest.

```ts
await updateModelLastUsed(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `cleanupLeastRecentlyUsed(category, options?)`

Deletes least-recently-used models in a category.

```ts
await cleanupLeastRecentlyUsed(ModelCategory.Stt, { keepCount: 2 });
```

## Bulk Operations

### `purgeAll(options?)`

Deletes complete and incomplete artifacts across all categories.

```ts
const purge = await purgeAll();
console.log(purge.deletedComplete, purge.skippedProtected);
```

### `getProtectedKeys()`

Returns keys that should not be deleted during bulk operations.

```ts
const protectedKeys = await getProtectedKeys();
```

## Events

### `onProgress(listener)`

Subscribes to progress updates; returns unsubscribe function.

```ts
const unsubscribe = onProgress((category, modelId, progress) => {
  console.log(category, modelId, progress.phase, progress.percent);
});
```

### `onModelsListUpdated(listener)`

Subscribes to registry updates; returns unsubscribe function.

```ts
const unsubscribe = onModelsListUpdated((category, models) => {
  console.log(category, models.length);
});
```

## Configuration & Utilities

### `configureBackgroundDownloader(options)`

Applies downloader runtime config before first download.

```ts
configureBackgroundDownloader({ showNotificationsEnabled: true });
```

### `checkDiskSpace(requiredBytes)`

Checks available storage with safety buffer.

```ts
const disk = await checkDiskSpace(750 * 1024 * 1024);
if (!disk.success) console.log(disk.message);
```

### `getStorageBasePath()`

Returns SDK storage base path.

```ts
const basePath = await getStorageBasePath();
```

## Types

### Core Types

| Type | Notes |
| --- | --- |
| `ModelCategory` | `Tts | Stt | Vad | Diarization | Enhancement | Separation | Qnn | Alignment` |
| `ModelMeta` | Unified model metadata type (TTS fields are optional) |
| `Progress` | `{ bytesProcessed, totalBytes, percent, phase, archiveEntryIndex?, speed?, eta? }` |
| `isActiveExtractionPhase(phase)` | `true` for `extracting` or `extracting_resume_skipping` (e.g. pause-extract UI) |
| `EnsureModelResult` | `{ modelId, localPath }` |
| `DownloadState` | Incomplete download state |
| `ExtractionState` | Incomplete extraction state; may include `lastEntryIndex` / `lastEntryPath` after `pauseExtraction` for native resume |
| `ModelWithMetadata` | Installed model + manifest data |
| `ChecksumMismatchInfo` | Checksum mismatch/failure callback payload |

### Option Types

| Type | Notes |
| --- | --- |
| `EnsureModelOptions` | Shared options for high-level flow |
| `DownloadOptions` | `EnsureModelOptions` + `maxRetries` |
| `ExtractOptions` | Extraction options (no overwrite) |

### Error Types

| Type | Notes |
| --- | --- |
| `PauseError` | Raised when operation is explicitly paused |
| `AbortError` | Raised when operation is canceled via `AbortSignal` |

## Troubleshooting

| Symptom | Likely Cause | Action |
| --- | --- | --- |
| `Unknown model id` | Registry cache not loaded | Call `refreshModels(...)` before download/ensure |
| `Archive is truncated` | Partial file or interrupted transfer | Call `deleteIncompleteDownload(...)` then retry |
| Checksum mismatch | Corrupted transfer or modified file | Use `onChecksumMismatch` to decide keep/reject |
| `AbortError` from extraction | Canceled by `AbortSignal` (not a pause) | Partial output may be removed; retry `extractModel(...)` or `ensureModel(...)` |
| `PauseError` from extraction | `pauseExtraction` while unpacking | Call `resumeExtraction(...)` or `ensureModel(...)`; archive + `.extraction-state-*.json` are kept |
| Empty model list | No cache + release fetch failed | Check network and retry `refreshModels(...)` |

