# Download Manager

Unified model download and extraction API for public SDK usage.

**Import path:** `react-native-sherpa-onnx/download`

## Peer dependency

`react-native-sherpa-onnx` declares **`@kesha-antonov/react-native-background-downloader` (^4.5.4)** as a peer dependency; install it in your app alongside this package to be able to use the download manager api from this sdk.

## Model ids

Use **`ModelMeta.id`** from **`listModels(category)`** after **`refreshModels(category)`** (or **`getModelById`**). It is the release asset name **without** `.tar.bz2` or `.onnx`. To pick ids by hand, open the GitHub release whose **tag** matches your category (assets list = valid ids + extension):

| `ModelCategory` | Release tag |
| --- | --- |
| `Tts` | [`tts-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |
| `Stt`, `Vad` | [`asr-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| `Diarization` | [`speaker-segmentation-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models) |
| `Enhancement` | [`speech-enhancement-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models) |
| `Separation` | [`source-separation-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/source-separation-models) |
| `Qnn` | [`asr-models-qnn-binary`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models-qnn-binary) |
| `Alignment` | [`alignment-models`](https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models) |

## Quick Start

### 1) One call: ensure model is ready

```ts
import {
  ModelCategory,
  ensureModel,
  refreshModels,
  type EnsureModelResult,
  type ModelMeta,
} from 'react-native-sherpa-onnx/download';

// refreshModels --> Promise<ModelMeta[]> — cached list for this category (id, displayName, downloadUrl, bytes, archiveExt, …).
const models: ModelMeta[] = await refreshModels(ModelCategory.Stt, { forceRefresh: true });
console.log(models[0]?.id); // could be: sherpa-onnx-whisper-tiny (use m.id for ensureModel / downloadModel)

// ensureModel --> Promise<EnsureModelResult> — { modelId, localPath }; localPath is the extracted model root.
const ready: EnsureModelResult = await ensureModel(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny',
  {
    onProgress: (p) => console.log(p.phase, p.percent),
  }
);
console.log(ready.localPath); // …/Documents/sherpa-onnx/models/stt/sherpa-onnx-whisper-tiny (pass to native STT init)
```

### 2) Low-level download with explicit pause/resume

```ts
import {
  ModelCategory,
  downloadModel,
  PauseError,
  pauseDownload,
  resumeDownload,
  type DownloadResult,
} from 'react-native-sherpa-onnx/download';

// downloadModel --> Promise<DownloadResult> (same shape as EnsureModelResult: { modelId, localPath }).
// The promise starts work immediately and keeps running until done, paused, or error.
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

// resumeDownload --> Promise<DownloadResult> when the full download (+ extract) pipeline finishes.
const finished: DownloadResult = await resumeDownload(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium'
);
console.log(finished.localPath); // …/Documents/sherpa-onnx/models/tts/vits-piper-en_US-lessac-medium
```

### 3) Extraction-only flow (archive already on disk)

```ts
import {
  ModelCategory,
  extractModel,
  PauseError,
  pauseExtraction,
  resumeExtraction,
  type DownloadResult,
} from 'react-native-sherpa-onnx/download';

// extractModel --> Promise<DownloadResult> — on success, { modelId, localPath } (extracted root).
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

// resumeExtraction --> Promise<DownloadResult> when unpacking completes.
const unpacked: DownloadResult = await resumeExtraction(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny'
);
console.log(unpacked.localPath); // …/Documents/sherpa-onnx/models/stt/sherpa-onnx-whisper-tiny
```

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
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

Each function below includes a one-line TypeScript signature (exported names match `react-native-sherpa-onnx/download`). Parameter names follow the implementation (`id` is the model id string).

## High-Level API

### `ensureModel(category, modelId, options?)`

```ts
function ensureModel(category: ModelCategory, id: string, opts?: EnsureModelOptions): Promise<EnsureModelResult>;
```

One-call flow: ready check -> resume extraction -> resume download -> extract archive -> download.

```ts
const ready = await ensureModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Registry

### `refreshModels(category, options?)`

```ts
function refreshModels(category: ModelCategory, options?: { forceRefresh?: boolean; cacheTtlMinutes?: number; maxRetries?: number; signal?: AbortSignal }): Promise<ModelMeta[]>;
```

Fetches remote release metadata and updates cache. For **`ModelCategory.Tts`**, TTS-specific fields (**`type`**, **`languages`**, **`quantization`**, **`sizeTier`**) are filled by calling the native TurboModule **`detectTtsModel`** once per release asset id (name-only heuristics; no filesystem scan of downloaded files).

```ts
await refreshModels(ModelCategory.Tts, { forceRefresh: true });
```

### `listModels(category)`

```ts
function listModels(category: ModelCategory): Promise<ModelMeta[]>;
```

Reads cached model list for one category.

```ts
const models = await listModels(ModelCategory.Alignment);
```

### `getModelById(category, modelId)`

```ts
function getModelById(category: ModelCategory, modelId: string): Promise<ModelMeta | null>;
```

Returns one model from the cached list or `null`.

```ts
const model = await getModelById(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `getModelsCacheStatus(category)`

```ts
function getModelsCacheStatus(category: ModelCategory): Promise<CacheStatus>;
```

Returns cache timestamp metadata.

```ts
const status = await getModelsCacheStatus(ModelCategory.Stt);
```

### `clearModelsCache(category)`

```ts
function clearModelsCache(category: ModelCategory): Promise<void>;
```

Deletes local cache for a category.

```ts
await clearModelsCache(ModelCategory.Stt);
```

## Download

### `downloadModel(category, modelId, options?)`

```ts
function downloadModel(category: ModelCategory, id: string, options?: DownloadOptions): Promise<DownloadResult>;
```

Starts model download and post-processing.

```ts
await downloadModel(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium', {
  onProgress: (p) => console.log(p.bytesProcessed, p.totalBytes),
});
```

### `pauseDownload(category, modelId)`

```ts
function pauseDownload(category: ModelCategory, id: string): Promise<void>;
```

Pauses an active download and keeps partial bytes.

```ts
await pauseDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

### `resumeDownload(category, modelId, options?)`

```ts
function resumeDownload(category: ModelCategory, id: string, options?: DownloadOptions): Promise<DownloadResult>;
```

Resumes a paused or interrupted download.

```ts
await resumeDownload(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

### `getIncompleteDownloads(category)`

```ts
function getIncompleteDownloads(category: ModelCategory): Promise<DownloadState[]>;
```

Lists paused/interrupted downloads in one category.

```ts
const pending = await getIncompleteDownloads(ModelCategory.Stt);
```

### `deleteIncompleteDownload(category, modelId)`

```ts
function deleteIncompleteDownload(category: ModelCategory, id: string): Promise<void>;
```

Removes partial download artifacts and state.

```ts
await deleteIncompleteDownload(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Extraction

### `extractModel(category, modelId, options?)`

```ts
function extractModel(category: ModelCategory, id: string, options?: ExtractOptions): Promise<DownloadResult>;
```

Starts extraction from an already available archive.

```ts
await extractModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `pauseExtraction(category, modelId)`

```ts
function pauseExtraction(category: ModelCategory, id: string): Promise<void>;
```

Pauses an active extraction. Resume metadata is persisted in `.extraction-state-<modelId>.json` as described above.

```ts
await pauseExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `resumeExtraction(category, modelId, options?)`

```ts
function resumeExtraction(category: ModelCategory, id: string, options?: ExtractOptions): Promise<DownloadResult>;
```

Resumes a paused or interrupted extraction using the saved `.extraction-state-*.json` (including **`lastEntryIndex`** when present) so native extraction resumes with the correct **`skipEntries`**.

```ts
await resumeExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `getIncompleteExtractions(category)`

```ts
function getIncompleteExtractions(category: ModelCategory): Promise<ExtractionState[]>;
```

Lists interrupted extractions in one category.

```ts
const extractionStates = await getIncompleteExtractions(ModelCategory.Stt);
```

### `deleteIncompleteExtraction(category, modelId)`

```ts
function deleteIncompleteExtraction(category: ModelCategory, id: string): Promise<void>;
```

Removes extraction state and partial output.

```ts
await deleteIncompleteExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

## Local Models

### `isModelDownloaded(category, modelId)`

```ts
function isModelDownloaded(category: ModelCategory, id: string): Promise<boolean>;
```

Checks if model is fully ready.

```ts
const ready = await isModelDownloaded(ModelCategory.Alignment, 'sherpa-onnx-wav2vec2.0-torchaudio');
```

### `getModelPath(category, modelId)`

```ts
function getModelPath(category: ModelCategory, id: string): Promise<string | null>;
```

Returns resolved local path for model initialization.

```ts
const path = await getModelPath(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `listDownloadedModels(category)`

```ts
function listDownloadedModels(category: ModelCategory): Promise<ModelMeta[]>;
```

Lists downloaded models (without runtime status fields).

```ts
const installed = await listDownloadedModels(ModelCategory.Stt);
```

### `listDownloadedModelsWithMetadata(category)`

```ts
function listDownloadedModelsWithMetadata(category: ModelCategory): Promise<ModelWithMetadata[]>;
```

Lists downloaded models with metadata (`downloadedAt`, `lastUsed`, `sizeOnDisk`, `status`).

```ts
const entries = await listDownloadedModelsWithMetadata(ModelCategory.Stt);
```

### `deleteModel(category, modelId)`

```ts
function deleteModel(category: ModelCategory, id: string): Promise<void>;
```

Deletes a fully downloaded model and local artifacts.

```ts
await deleteModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `updateModelLastUsed(category, modelId)`

```ts
function updateModelLastUsed(category: ModelCategory, id: string): Promise<void>;
```

Updates `lastUsed` timestamp in model manifest.

```ts
await updateModelLastUsed(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### `cleanupLeastRecentlyUsed(category, options?)`

```ts
function cleanupLeastRecentlyUsed(category: ModelCategory, options?: { targetBytes?: number; maxModelsToDelete?: number; keepCount?: number }): Promise<string[]>;
```

Deletes least-recently-used models in a category.

```ts
await cleanupLeastRecentlyUsed(ModelCategory.Stt, { keepCount: 2 });
```

## Bulk Operations

### `purgeAll(options?)`

```ts
function purgeAll(options?: { protectKeys?: ReadonlySet<string> }): Promise<PurgeAllResult>;
```

Deletes complete and incomplete artifacts across all categories.

```ts
const purge = await purgeAll();
console.log(purge.deletedComplete, purge.skippedProtected);
```

### `getProtectedKeys()`

```ts
function getProtectedKeys(): Promise<ReadonlySet<string>>;
```

Returns keys that should not be deleted during bulk operations.

```ts
const protectedKeys = await getProtectedKeys();
```

## Events

### `onProgress(listener)`

```ts
function onProgress(listener: DownloadProgressListener): () => void;
```

Subscribes to progress updates; returns unsubscribe function.

```ts
const unsubscribe = onProgress((category, modelId, progress) => {
  console.log(category, modelId, progress.phase, progress.percent);
});
```

### `onModelsListUpdated(listener)`

```ts
function onModelsListUpdated(listener: ModelsListUpdatedListener): () => void;
```

Subscribes to registry updates; returns unsubscribe function.

```ts
const unsubscribe = onModelsListUpdated((category, models) => {
  console.log(category, models.length);
});
```

## Configuration & Utilities

### `configureBackgroundDownloader(options)`

```ts
function configureBackgroundDownloader(options: BackgroundDownloaderSetConfigOptions): void;
```

Applies downloader runtime config before first download.

```ts
configureBackgroundDownloader({ showNotificationsEnabled: true });
```

### `checkDiskSpace(requiredBytes)`

```ts
function checkDiskSpace(requiredBytes: number): Promise<ValidationResult>;
```

Checks available storage with safety buffer.

```ts
const disk = await checkDiskSpace(750 * 1024 * 1024);
if (!disk.success) console.log(disk.message);
```

### `getStorageBasePath()`

```ts
function getStorageBasePath(): Promise<string>;
```

Returns SDK storage base path.

```ts
const basePath = await getStorageBasePath();
```

## Types

### Core Types

| Type | Notes |
| --- | --- |
| `ModelCategory` | Enum: `Tts`, `Stt`, `Vad`, `Diarization`, `Enhancement`, `Separation`, `Qnn`, `Alignment` |
| `ModelMeta` | Unified model metadata type (TTS fields are optional) |
| `Progress` | `{ bytesProcessed, totalBytes, percent, phase, archiveEntryIndex?, speed?, eta? }` |
| `isActiveExtractionPhase(phase)` | `true` for `extracting` or `extracting_resume_skipping` (e.g. pause-extract UI) |
| `EnsureModelResult` | `{ modelId, localPath }` |
| `DownloadResult` | Same shape as `EnsureModelResult` |
| `DownloadState` | Incomplete download state |
| `ExtractionState` | Incomplete extraction state; may include `lastEntryIndex` / `lastEntryPath` after `pauseExtraction` for native resume |
| `ModelWithMetadata` | Installed model + manifest data |
| `ChecksumMismatchInfo` | Checksum mismatch/failure callback payload |
| `CacheStatus` | Return type of `getModelsCacheStatus` |
| `DownloadProgressListener` | `(category, modelId, progress) => void` — parameter of `onProgress` |
| `ModelsListUpdatedListener` | `(category, models) => void` — parameter of `onModelsListUpdated` |
| `PurgeAllResult` | Return type of `purgeAll` |
| `BackgroundDownloaderSetConfigOptions` | Parameter type of `configureBackgroundDownloader` |
| `ValidationResult` | Return type of `checkDiskSpace` (instance with `success`, optional `error`, `message`) |

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

