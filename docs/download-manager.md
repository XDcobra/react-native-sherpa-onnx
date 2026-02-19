# Model Download Manager

This guide covers the model download APIs provided by `react-native-sherpa-onnx/download`.

## Overview

The download manager fetches model assets from official sherpa-onnx GitHub Releases, caches them locally, verifies checksums when available, and exposes progress events. It supports both archive models (`.tar.bz2`) and single-file models (`.onnx`).

## Quick Start

Typical flow: refresh the registry, download a model, then initialize STT/TTS with the local path.

```typescript
import {
  ModelCategory,
  refreshModelsByCategory,
  downloadModelByCategory,
  getLocalModelPathByCategory,
} from 'react-native-sherpa-onnx/download';
import { initializeTTS } from 'react-native-sherpa-onnx/tts';

await refreshModelsByCategory(ModelCategory.Tts, { forceRefresh: true });
await downloadModelByCategory(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');

const localPath = await getLocalModelPathByCategory(
  ModelCategory.Tts,
  'vits-piper-en_US-lessac-medium'
);

if (localPath) {
  await initializeTTS({
    modelPath: { type: 'file', path: localPath },
    modelType: 'auto',
  });
}
```

## API Reference

### `refreshModelsByCategory(category, options?)`

Fetch and cache the latest model list from GitHub Releases. Use this before showing the available models UI.

```typescript
await refreshModelsByCategory(ModelCategory.Stt, { forceRefresh: true });
```

### `listModelsByCategory(category)`

Return the cached model list. If no cache exists yet, this returns an empty array.

```typescript
const models = await listModelsByCategory(ModelCategory.Stt);
```

### `downloadModelByCategory(category, id, options?)`

Download a model by id. Supports progress callbacks, cancellation, and retries.

```typescript
await downloadModelByCategory(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny', {
  onProgress: (progress) => {
    console.log(progress.percent, progress.speed, progress.eta);
  },
});
```

### `getLocalModelPathByCategory(category, id)`

Get the local path of a downloaded model for initialization.

```typescript
const localPath = await getLocalModelPathByCategory(
  ModelCategory.Stt,
  'sherpa-onnx-whisper-tiny'
);
```

### `listDownloadedModelsByCategory(category)`

Return only models that are already downloaded on this device.

```typescript
const downloaded = await listDownloadedModelsByCategory(ModelCategory.Tts);
```

### `isModelDownloadedByCategory(category, id)`

Check whether a model is downloaded.

### `getModelsCacheStatusByCategory(category)`

Return the last update timestamp for the cached registry.

### `getModelByIdByCategory(category, id)`

Return metadata for a specific model id.

### `deleteModelByCategory(category, id)`

Remove a downloaded model and its cached files.

```typescript
await deleteModelByCategory(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

### `clearModelCacheByCategory(category)`

Clear the cached registry for a category.

### `subscribeDownloadProgress(listener)`

Subscribe to download progress updates. Returns an unsubscribe function.

### `subscribeModelsListUpdated(listener)`

Subscribe to model list refresh events. Returns an unsubscribe function.

## Progress events

`subscribeDownloadProgress` delivers progress updates for downloads and extraction, including speed and ETA when available.

```typescript
import { subscribeDownloadProgress } from 'react-native-sherpa-onnx/download';

const unsubscribe = subscribeDownloadProgress((category, modelId, progress) => {
  console.log(category, modelId, progress.percent, progress.speed, progress.eta);
});

// call unsubscribe() when you no longer need updates
```

## Checksums

The download manager validates checksums when available:

- For archives, validation uses native hashing during extraction.
- For single-file models (`.onnx`), validation uses a local SHA-256 calculation.
- When `checksum.txt` does not list a file, the GitHub asset digest is used if provided.

## Validation helpers

Public helpers in `src/download/validation.ts` include checksum and disk space utilities. You can import them from `react-native-sherpa-onnx/download`, but most apps only need the high-level download manager API.
