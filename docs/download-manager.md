# Download Manager

## Introduction

Unified model download and extraction API for public SDK usage.

**Import path:** `react-native-sherpa-onnx/download`

The current API is source-aware and supports built-in and custom providers.
Core goals:

- source-aware model discovery and install (`github_k2_fsa`, `github_xdcobra`, `huggingface`, custom providers)
- stable `DOWNLOAD_*` error contract
- retry disabled by default (opt-in via `requestPolicy`)
- unified model metadata via `layout + assets[]`

## Peer dependency

`react-native-sherpa-onnx` declares **`@dr.pogodin/react-native-fs`** as a peer dependency (file I/O for downloads and model storage).

Model downloads run in the **foreground** (while the app process is active). Interrupted downloads resume via HTTP **Range** from partial files on disk and `.download-state-*.json` state files. No separate background-downloader package is required.

## Model ids

Use **`ModelMeta.id`** from **`listModels(category, { source })`** after **`refreshModels(category, { source })`** (or **`getModelById`**).

For built-in GitHub sources, ids come from release assets (without archive extension). For `huggingface` and custom sources, ids come from the provider response.

### Built-in GitHub release tags

The following mapping is relevant when using the built-in GitHub providers (`github_k2_fsa` / `github_xdcobra`):

| `ModelCategory` | Release tag                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `Tts`           | [`tts-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)                                   |
| `Stt`, `Vad`    | [`asr-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)                                   |
| `Punctuation`   | [`punctuation-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/punctuation-models)                   |
| `Diarization`   | [`speaker-segmentation-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models) |
| `Enhancement`   | [`speech-enhancement-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models)     |
| `Separation`    | [`source-separation-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/source-separation-models)       |
| `SpeakerEmbedding` | [`speaker-recongition-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) |
| `Qnn`           | [`asr-models-qnn-binary`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models-qnn-binary)             |
| `Alignment`     | [`alignment-models`](https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models)         |

## Quick start

### 1) One call: ensure model is ready

```ts
import {
  ModelCategory,
  ensureModel,
  refreshModels,
  BUILTIN_SOURCE_IDS,
  type EnsureModelResult,
  type ModelMeta,
} from 'react-native-sherpa-onnx/download';

const source = BUILTIN_SOURCE_IDS.GITHUB_K2_FSA;

const models: ModelMeta[] = await refreshModels(ModelCategory.Stt, {
  source,
  forceRefresh: true,
});
console.log(models[0]?.id);

const ready: EnsureModelResult = await ensureModel(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny',
  {
    source,
    onProgress: (p) => console.log(p.phase, p.percent),
  }
);

console.log(ready.localPath);
```

### 2) Low-level download with explicit pause/resume

```ts
import {
  ModelCategory,
  downloadModel,
  PauseError,
  pauseDownload,
  resumeDownload,
  BUILTIN_SOURCE_IDS,
  type DownloadResult,
} from 'react-native-sherpa-onnx/download';

const source = BUILTIN_SOURCE_IDS.HUGGINGFACE;

const run = downloadModel(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium', {
  source,
  onProgress: (p) => console.log(p.percent),
});

await pauseDownload(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium',
  source
);

try {
  await run;
} catch (error) {
  if (!(error instanceof PauseError)) {
    throw error;
  }
}

const finished: DownloadResult = await resumeDownload(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium',
  { source }
);

console.log(finished.localPath);
```

### 3) Extraction-only flow (archive already on disk)

```ts
import {
  ModelCategory,
  extractModel,
  PauseError,
  pauseExtraction,
  resumeExtraction,
  BUILTIN_SOURCE_IDS,
  type DownloadResult,
} from 'react-native-sherpa-onnx/download';

const source = BUILTIN_SOURCE_IDS.GITHUB_K2_FSA;

const extraction = extractModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny', {
  source,
});

await pauseExtraction(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny', source);

try {
  await extraction;
} catch (error) {
  if (!(error instanceof PauseError)) {
    throw error;
  }
}

const unpacked: DownloadResult = await resumeExtraction(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny',
  { source }
);

console.log(unpacked.localPath);
```

### 4) Switch source defaults and configure headers/token

```ts
import {
  ModelCategory,
  BUILTIN_SOURCE_IDS,
  configureSource,
  setDefaultSourceForCategory,
  getDefaultSourceForCategory,
} from 'react-native-sherpa-onnx/download';

configureSource(BUILTIN_SOURCE_IDS.HUGGINGFACE, {
  token: process.env.HF_TOKEN,
  tokenScheme: 'Bearer',
  headers: {
    'X-Custom-Header': 'value',
  },
  requestPolicy: {
    retries: 1,
    initialDelayMs: 300,
    maxDelayMs: 1200,
  },
});

setDefaultSourceForCategory(ModelCategory.Stt, BUILTIN_SOURCE_IDS.HUGGINGFACE);
console.log(getDefaultSourceForCategory(ModelCategory.Stt));
```

### 5) Register a custom source provider

```ts
import {
  ModelCategory,
  registerSource,
  type SourceProvider,
  type SourceModel,
} from 'react-native-sherpa-onnx/download';

const customMirror: SourceProvider = {
  id: 'custom_mirror',
  label: 'Custom Mirror',
  supportsCategory(category) {
    return category === ModelCategory.Stt;
  },
  async listModels(category, ctx): Promise<SourceModel[]> {
    const response = await fetch('https://mirror.example.com/stt/models', {
      headers: ctx.headers,
      signal: ctx.signal,
    });
    const body = await response.json();
    return body.models as SourceModel[];
  },
};

registerSource(customMirror);
```

## Setup (iOS & Android)

| Topic   | Requirement                                      |
| ------- | ------------------------------------------------ |
| Android | No extra download permissions beyond network     |
| iOS     | Downloads run in-process while the app is active |

### Configure download manager (optional)

```ts
import { configureDownloadManager } from 'react-native-sherpa-onnx/download';

configureDownloadManager({
  maxParallelDownloads: 3, // multi-asset HF folder layouts
});
```

### Source-aware storage layout

Downloaded artifacts are grouped by source:

- model root:
  - `/Documents/sherpa-onnx/models/<category>/sources/<sourceId>/<modelId>/`
- download state:
  - `/Documents/sherpa-onnx/models/<category>/sources/<sourceId>/.download-state-<modelId>.json`
- extraction state:
  - `/Documents/sherpa-onnx/models/<category>/sources/<sourceId>/.extraction-state-<modelId>.json`

For archive layouts, the downloaded archive also lives under the same source directory.

### Retry policy

Retries are off by default.

If needed, set retries per request:

```ts
import {
  refreshModels,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';

await refreshModels(ModelCategory.Stt, {
  source: 'default',
  requestPolicy: {
    retries: 2,
    initialDelayMs: 300,
    maxDelayMs: 1200,
  },
});
```

## API reference

Each function below includes a one-line TypeScript signature (exported names match `react-native-sherpa-onnx/download`).

Most read/write operations accept optional source selection:

- `options.source?: string | 'default'` or
- explicit `source?: string | 'default'` positional argument for pause/delete helpers.

## High-Level API

### `ensureModel(category, modelId, options?)`

```ts
function ensureModel(
  category: ModelCategory,
  id: string,
  opts?: EnsureModelOptions
): Promise<EnsureModelResult>;
```

One-call flow: ready check -> resume extraction -> resume download -> extract archive -> download.

## Registry

### `refreshModels(category, options?)`

```ts
function refreshModels(
  category: ModelCategory,
  options?: {
    forceRefresh?: boolean;
    cacheTtlMinutes?: number;
    signal?: AbortSignal;
    requestPolicy?: RequestPolicy;
    source?: string | 'default';
  }
): Promise<ModelMeta[]>;
```

Fetches remote source metadata and updates cache.

### `listModels(category, options?)`

```ts
function listModels(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<ModelMeta[]>;
```

Reads cached model list for one category and source.

### `getModelById(category, modelId, options?)`

```ts
function getModelById(
  category: ModelCategory,
  modelId: string,
  options?: { source?: string | 'default' }
): Promise<ModelMeta | null>;
```

Returns one model from cache or `null`.

### `getModelsCacheStatus(category, options?)`

```ts
function getModelsCacheStatus(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<CacheStatus>;
```

Returns cache timestamp metadata for one category/source.

### `clearModelsCache(category, options?)`

```ts
function clearModelsCache(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<void>;
```

Deletes local cache for one category and optionally one source.

## Sources

### Source registry and defaults

```ts
registerSource(provider: SourceProvider): void;
unregisterSource(sourceId: string): void;
getSource(sourceId: string): SourceProvider;
tryGetSource(sourceId: string): SourceProvider | undefined;
listSources(): SourceProvider[];
listBuiltinSources(): SourceProvider[];
setDefaultSourceForCategory(category: ModelCategory, sourceId: string): void;
getDefaultSourceForCategory(category: ModelCategory): string;
ensureBuiltinSourcesRegistered(): void;
```

### Source configuration and fetch helpers

```ts
configureSource(sourceId: string, config: SourceConfig): void;
getSourceConfig(sourceId: string): Readonly<SourceConfig>;
buildSourceFetchContext(sourceId: string, provider: SourceProvider, options?): SourceFetchContext;
sourceFetch(url: string, options?: SourceFetchOptions): Promise<SourceFetchResult>;
```

### Built-ins

```ts
BUILTIN_SOURCE_IDS;
configureHuggingFaceSource(config: HuggingFaceSourceConfig): void;
getHuggingFaceSourceConfig(): Readonly<HuggingFaceSourceConfig>;
```

Built-in source ids:

- `github_k2_fsa`
- `github_xdcobra`
- `huggingface`

## Download

### `downloadModel(category, modelId, options?)`

```ts
function downloadModel(
  category: ModelCategory,
  id: string,
  options?: DownloadOptions
): Promise<DownloadResult>;
```

Starts model download and post-processing.

### `pauseDownload(category, modelId, source?)`

```ts
function pauseDownload(
  category: ModelCategory,
  id: string,
  source?: string | 'default'
): Promise<void>;
```

Pauses an active download and keeps partial bytes for resume.

### `resumeDownload(category, modelId, options?)`

```ts
function resumeDownload(
  category: ModelCategory,
  id: string,
  options?: DownloadOptions
): Promise<DownloadResult>;
```

Resumes a paused/interrupted download.

### `getIncompleteDownloads(category, options?)`

```ts
function getIncompleteDownloads(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<DownloadState[]>;
```

Lists paused/interrupted downloads in one category/source.

### `deleteIncompleteDownload(category, modelId, source?)`

```ts
function deleteIncompleteDownload(
  category: ModelCategory,
  id: string,
  source?: string | 'default'
): Promise<void>;
```

Removes partial download artifacts and state.

## Extraction

### `extractModel(category, modelId, options?)`

```ts
function extractModel(
  category: ModelCategory,
  id: string,
  options?: ExtractOptions
): Promise<DownloadResult>;
```

Starts extraction from an already available archive.

### `pauseExtraction(category, modelId, source?)`

```ts
function pauseExtraction(
  category: ModelCategory,
  id: string,
  source?: string | 'default'
): Promise<void>;
```

Pauses active extraction and keeps resume metadata.

### `resumeExtraction(category, modelId, options?)`

```ts
function resumeExtraction(
  category: ModelCategory,
  id: string,
  options?: ExtractOptions
): Promise<DownloadResult>;
```

Resumes paused/incomplete extraction.

### `getIncompleteExtractions(category, options?)`

```ts
function getIncompleteExtractions(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<ExtractionState[]>;
```

Lists interrupted extractions in one category/source.

### `deleteIncompleteExtraction(category, modelId, source?)`

```ts
function deleteIncompleteExtraction(
  category: ModelCategory,
  id: string,
  source?: string | 'default'
): Promise<void>;
```

Removes extraction state and partial output.

## Local Models

### `isModelDownloaded(category, modelId, options?)`

```ts
function isModelDownloaded(
  category: ModelCategory,
  id: string,
  options?: { source?: string | 'default' }
): Promise<boolean>;
```

Checks whether a model is fully ready.

### `getModelPath(category, modelId, options?)`

```ts
function getModelPath(
  category: ModelCategory,
  id: string,
  options?: { source?: string | 'default' }
): Promise<string | null>;
```

Returns resolved local path for model initialization.

### `listDownloadedModels(category, options?)`

```ts
function listDownloadedModels(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<ModelMeta[]>;
```

Lists downloaded models.

### `listDownloadedModelsWithMetadata(category, options?)`

```ts
function listDownloadedModelsWithMetadata(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<ModelWithMetadata[]>;
```

Lists installed models with manifest metadata.

### `deleteModel(category, modelId, source?)`

```ts
function deleteModel(
  category: ModelCategory,
  id: string,
  source?: string | 'default'
): Promise<void>;
```

Deletes a fully downloaded model and local artifacts.

### `updateModelLastUsed(category, modelId, options?)`

```ts
function updateModelLastUsed(
  category: ModelCategory,
  id: string,
  options?: { source?: string | 'default' }
): Promise<void>;
```

Updates `lastUsed` timestamp in model manifest.

### `cleanupLeastRecentlyUsed(category, options?)`

```ts
function cleanupLeastRecentlyUsed(
  category: ModelCategory,
  options?: {
    targetBytes?: number;
    maxModelsToDelete?: number;
    keepCount?: number;
    source?: string | 'default';
  }
): Promise<string[]>;
```

Deletes least-recently-used models for one category/source.

## Bulk Operations

### `purgeAll(options?)`

```ts
function purgeAll(options?: {
  protectKeys?: ReadonlySet<string>;
}): Promise<PurgeAllResult>;
```

Deletes complete and incomplete artifacts across all categories/sources.

### `getProtectedKeys()`

```ts
function getProtectedKeys(): Promise<ReadonlySet<string>>;
```

Returns operation keys that must not be removed by bulk cleanup.

## Events

### `onProgress(listener)`

```ts
function onProgress(listener: DownloadProgressListener): () => void;
```

Subscribes to progress updates; returns unsubscribe function.

### `onModelsListUpdated(listener)`

```ts
function onModelsListUpdated(listener: ModelsListUpdatedListener): () => void;
```

Subscribes to registry updates; returns unsubscribe function.

## Configuration & Utilities

### `configureDownloadManager(options)`

```ts
function configureDownloadManager(options?: {
  maxParallelDownloads?: number;
}): void;
```

Sets parallel download limit for multi-asset folder layouts.

### `checkDiskSpace(requiredBytes)`

```ts
function checkDiskSpace(requiredBytes: number): Promise<ValidationResult>;
```

Checks available storage with safety buffer.

### `getStorageBasePath()`

```ts
function getStorageBasePath(): Promise<string>;
```

Returns SDK storage base path.

## Types and constants

### Core model and download types

- `ModelCategory`
- `ModelMeta`
- `Progress`
- `ProgressPhase`
- `EnsureModelOptions`
- `EnsureModelResult`
- `DownloadOptions`
- `DownloadResult`
- `DownloadState`
- `ExtractOptions`
- `ExtractionState`
- `ModelWithMetadata`
- `CacheStatus`
- `ChecksumMismatchInfo`

### Source types and constants

- `BUILTIN_SOURCE_IDS`
- `BuiltinSourceId`
- `SourceProvider`
- `SourceModel`
- `SourceAssetLayout`
- `SourceAssetEntry`
- `SourceArchiveFormat`
- `SourceFetchContext`
- `SourceFetchOptions`
- `SourceFetchResult`
- `SourceConfig`
- `RequestPolicy`
- `SUPPORTED_ARCHIVE_FORMATS`

### Error and guards

- `PauseError`
- `DownloadError`
- `DownloadErrorCode`
- `DOWNLOAD_ERROR_CODES`
- `isPauseError(error)`
- `isPauseCompatibleError(error)`
- `isDownloadError(error)`
- `isDownloadErrorCode(value)`
- `isActiveExtractionPhase(phase)`
- `isArchiveLayout(layout)`
- `isFolderLayout(layout)`
- `isSupportedArchiveFormat(format)`

## Error codes

| Code                                   | Meaning                                          |
| -------------------------------------- | ------------------------------------------------ |
| `DOWNLOAD_UNKNOWN_SOURCE`              | Source id not registered                         |
| `DOWNLOAD_SOURCE_LIST_FAILED`          | Source cannot list models for requested category |
| `DOWNLOAD_SOURCE_AUTH_FAILED`          | Auth/token failure for source request            |
| `DOWNLOAD_NETWORK_FAILED`              | Network/transport failure during source fetch    |
| `DOWNLOAD_HTTP_STATUS`                 | Non-success HTTP status from remote              |
| `DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH` | Hash mismatch after transfer                     |
| `DOWNLOAD_INTEGRITY_TRUNCATED`         | File size indicates truncated transfer           |
| `DOWNLOAD_EXTRACT_FAILED`              | Archive extraction failed                        |
| `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT`  | Layout uses unsupported archive format           |
| `DOWNLOAD_DISK_SPACE_INSUFFICIENT`     | Available disk is below required threshold       |
| `DOWNLOAD_CANCELLED`                   | Explicit cancellation/abort                      |
| `DOWNLOAD_PAUSED`                      | Explicit pause state                             |
| `DOWNLOAD_INVALID_LAYOUT`              | Source returned invalid layout/assets contract   |

When handling failures, branch on `isPauseError(error)` / `isPauseCompatibleError(error)` first, then `isDownloadError(error)` and `error.code`.

## Troubleshooting

| Symptom                               | Likely Cause                                         | Action                                                               |
| ------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `Unknown model id`                    | Registry cache for selected source is stale or empty | Call `refreshModels(category, { source, forceRefresh: true })` first |
| `DOWNLOAD_SOURCE_AUTH_FAILED`         | Missing/invalid token or headers                     | Use `configureSource(sourceId, { token, headers })`                  |
| `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT` | Provider returned unsupported archive layout         | Return one of supported formats only                                 |
| `DOWNLOAD_INVALID_LAYOUT`             | Provider returned inconsistent `layout`/`assets`     | Validate provider output before returning models                     |
| Truncated archive/checksum mismatch   | Interrupted or corrupted transfer                    | `deleteIncompleteDownload(...)`, then download again                 |
| Empty model list                      | Fetch failed and no valid cache present              | Check network/source endpoint and retry refresh                      |

## Use case examples

<details>
<summary>Warm up mandatory models during app bootstrap</summary>

```ts
import {
  BUILTIN_SOURCE_IDS,
  ModelCategory,
  ensureModel,
  refreshModels,
} from 'react-native-sherpa-onnx/download';

const source = BUILTIN_SOURCE_IDS.GITHUB_K2_FSA;

await refreshModels(ModelCategory.Stt, { source, forceRefresh: true });

const stt = await ensureModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny', {
  source,
  onProgress: (p) => console.log('[stt]', p.phase, p.percent),
});

const vad = await ensureModel(ModelCategory.Vad, 'silero_vad', {
  source,
  onProgress: (p) => console.log('[vad]', p.phase, p.percent),
});

console.log(stt.localPath, vad.localPath);
```

</details>

<details>
<summary>Pause and resume long download from background-safe UI controls</summary>

```ts
import {
  BUILTIN_SOURCE_IDS,
  ModelCategory,
  downloadModel,
  isPauseError,
  pauseDownload,
  resumeDownload,
} from 'react-native-sherpa-onnx/download';

const source = BUILTIN_SOURCE_IDS.HUGGINGFACE;

const run = downloadModel(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium', {
  source,
});

await pauseDownload(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium',
  source
);

try {
  await run;
} catch (error) {
  if (!isPauseError(error)) {
    throw error;
  }
}

const done = await resumeDownload(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium',
  { source }
);

console.log(done.localPath);
```

</details>

<details>
<summary>Two custom sources (example.com/stt + example.com/tts) with mixed assets and Basic Auth</summary>

```ts
import {
  ModelCategory,
  configureSource,
  ensureModel,
  refreshModels,
  registerSource,
  sourceFetch,
  type SourceFetchContext,
  type SourceModel,
  type SourceProvider,
} from 'react-native-sherpa-onnx/download';

type RemoteModel = {
  id: string;
  displayName: string;
  type: 'archive' | 'mixed-folder';
  archiveUrl?: string;
  rootOnnxUrl?: string;
  tokensUrl?: string;
  legacyArchiveUrl?: string;
  bytes?: number;
};

async function listExampleModels(
  endpoint: string,
  category: ModelCategory,
  ctx: SourceFetchContext
): Promise<SourceModel[]> {
  const { response } = await sourceFetch(endpoint, ctx, {
    headers: {
      Accept: 'application/json',
    },
  });

  const body = (await response.json()) as { models: RemoteModel[] };

  return body.models.map((model) => {
    if (model.type === 'archive') {
      return {
        id: model.id,
        displayName: model.displayName,
        category,
        layout: {
          kind: 'archive',
          format: 'tar.bz2',
          extract: true,
        },
        assets: [
          {
            relativePath: `${model.id}.tar.bz2`,
            url: model.archiveUrl ?? `${endpoint}/${model.id}.tar.bz2`,
            bytes: model.bytes,
          },
        ],
        bytes: model.bytes ?? 0,
      };
    }

    return {
      id: model.id,
      displayName: model.displayName,
      category,
      layout: {
        kind: 'folder',
        format: 'none',
        extract: false,
      },
      assets: [
        {
          // Root file in model directory
          relativePath: 'model.onnx',
          url: model.rootOnnxUrl ?? `${endpoint}/${model.id}/model.onnx`,
        },
        {
          // Regular nested asset
          relativePath: 'config/tokens.txt',
          url: model.tokensUrl ?? `${endpoint}/${model.id}/config/tokens.txt`,
        },
        {
          // Archive file inside folder-layout model (stored as file, not auto-extracted)
          relativePath: 'legacy/old-weights.tar.gz',
          url:
            model.legacyArchiveUrl ??
            `${endpoint}/${model.id}/legacy/old-weights.tar.gz`,
        },
      ],
      bytes: model.bytes ?? 0,
    };
  });
}

const sttSource: SourceProvider = {
  id: 'example_stt',
  label: 'Example STT Source',
  supportsCategory: (category) => category === ModelCategory.Stt,
  listModels: (_category, ctx) =>
    listExampleModels('https://example.com/stt/models', ModelCategory.Stt, ctx),
};

const ttsSource: SourceProvider = {
  id: 'example_tts',
  label: 'Example TTS Source',
  supportsCategory: (category) => category === ModelCategory.Tts,
  listModels: (_category, ctx) =>
    listExampleModels('https://example.com/tts/models', ModelCategory.Tts, ctx),
};

registerSource(sttSource);
registerSource(ttsSource);

// user:password must be Base64-encoded (for example: "myuser:mypass" -> "bXl1c2VyOm15cGFzcw==")
const basicToken = 'bXl1c2VyOm15cGFzcw==';

configureSource('example_stt', {
  token: basicToken,
  tokenScheme: 'Basic',
  headers: {
    'X-Client': 'sherpa-mobile',
  },
});

configureSource('example_tts', {
  token: basicToken,
  tokenScheme: 'Basic',
  headers: {
    'X-Client': 'sherpa-mobile',
  },
});

await refreshModels(ModelCategory.Stt, {
  source: 'example_stt',
  forceRefresh: true,
});

await refreshModels(ModelCategory.Tts, {
  source: 'example_tts',
  forceRefresh: true,
});

const sttReady = await ensureModel(ModelCategory.Stt, 'stt-mixed-assets-v1', {
  source: 'example_stt',
});

const ttsReady = await ensureModel(ModelCategory.Tts, 'tts-voice-en-v1', {
  source: 'example_tts',
});

console.log(sttReady.localPath, ttsReady.localPath);
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) - Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
