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
  - [Android: foreground service & notifications](#android-foreground-service--notifications)
- [API Reference](#api-reference)
  - [Configure background downloader (optional)](#configure-model-download-background-downloader-optional)
  - [Registry & Listing](#registry--listing)
  - [Download & Delete](#download--delete)
  - [Bulk purge (all categories)](#bulk-purge-all-categories)
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
| Bulk purge (disk) | ✅ | `purgeDownloadedModelArtifacts()` — all categories; respects active downloads & extraction |

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

#### Android: foreground service & notifications

The dependency [@kesha-antonov/react-native-background-downloader](https://github.com/kesha-antonov/react-native-background-downloader) merges **`FOREGROUND_SERVICE`** and **`FOREGROUND_SERVICE_DATA_SYNC`** into your **merged manifest** (needed for downloads while the app is backgrounded). On **Google Play**, complete the **foreground service permissions** declaration under **Policy --> App content** when the console asks for it (and provide any required demo video).

**Visible download notifications**

The upstream library defaults to **minimal / effectively hidden** notifications (`showNotificationsEnabled: false`). If you do **not** call [`configureModelDownloadBackgroundDownloader()`](#configure-model-download-background-downloader-optional) yourself, this SDK turns **visible** notifications on automatically the **first** time a download runs in the process (`downloadModelByCategory` or `resumeDownload`), via `setConfig({ showNotificationsEnabled: true, … })` with generic English copy (“Model download”, progress text). Users should then see an ongoing notification while a model file is downloading.

**Android 13+ (API 33) — `POST_NOTIFICATIONS`**

Posting a normal ongoing notification requires:

1. In `AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
   ```
2. At **runtime**, request the permission (e.g. `PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, …)`) before or when the user starts a download.

Without this, the foreground download work may still run, but the **notification may not appear** in the shade—poor UX and difficult to record for Play policy.

**Extraction progress notifications (Android)**

After a download completes, **`runPostDownloadProcessing`** (used by `downloadModelByCategory`, `resumeDownload`, `extractModelByCategory`, etc.) runs native archive extraction. On **Android**, a separate **low-priority** ongoing notification (channel `sherpa_onnx_extraction`) shows unpack progress and is **cancelled when extraction finishes** (success or failure). This mirrors download visibility for long unpacks. **iOS** does not show a system extraction notification (same policy as NSURLSession download UX). Advanced apps can pass `showExtractionNotifications: false` (and optional title/text) via **`RunPostDownloadProcessingOptions`** when calling the post-download pipeline directly; the public **`extractArchive`** API also supports `showNotificationsEnabled` / `notificationTitle` / `notificationText` (see [extraction.md](extraction.md)).

**Customizing downloader config (titles, grouping, headers, …)**

Call **`configureModelDownloadBackgroundDownloader(options)`** from `react-native-sherpa-onnx/download` **once at app startup** (e.g. in `App.tsx`) **before** any model download. It forwards to the underlying `setConfig` and tells the SDK **not** to apply its built-in default notification settings on first download. The `options` shape is the same as `@kesha-antonov/react-native-background-downloader`’s `setConfig` (type **`BackgroundDownloaderSetConfigOptions`**).

Avoid calling `setConfig` **directly** on that package before the first download unless you also use this SDK helper: a bare `setConfig` is **overwritten** when the first download runs, because the SDK cannot detect that you already configured it.

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

### Configure model download background downloader (optional)

#### `configureModelDownloadBackgroundDownloader(options)`

Forwards to `@kesha-antonov/react-native-background-downloader` **`setConfig`**. Call **before the first** `downloadModelByCategory` / `resumeDownload` / `ensureModelByCategory` that starts a network download so your notification copy, grouping, or other settings are kept. If you never call it, the SDK applies [visible default notifications](#android-foreground-service--notifications) on first download instead.

```typescript
import { configureModelDownloadBackgroundDownloader } from 'react-native-sherpa-onnx/download';

configureModelDownloadBackgroundDownloader({
  showNotificationsEnabled: true,
  notificationsGrouping: {
    enabled: false,
    mode: 'individual',
    texts: {
      downloadTitle: 'My App',
      downloadStarting: 'Fetching speech model…',
      downloadProgress: 'Downloading… {progress}%',
    },
  },
});
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

### Bulk purge (all categories)

Use this when you want a **single operation** to free as much Sherpa download disk space as possible—for example a **“Delete all downloaded models”** button in settings, a **developer reset**, or **preparing storage** before the user signs out. Unlike `deleteModelByCategory`, this walks **every** `ModelCategory` (TTS, STT, VAD, QNN, …) and removes completed installs, stuck partial downloads, and stuck partial extractions.

#### `getProtectedModelKeysForBulkDelete()`

Returns a `Promise<ReadonlySet<string>>` of model keys that **must not** be deleted while work is in flight. Each key is `category:modelId` (same shape as internally for download tasks).

The set is the union of:

- In-process **JavaScript** download tasks tracked by the manager
- Models currently in **post-download processing** (extraction, checksum, validation)—so a purge in the middle of `ensureModelByCategory` does not rip the folder out from under the pipeline
- Tasks reported by the **native background downloader** (`getExistingDownloadTasks`), when available

If that native query throws, the function still returns JS/post-process protection.

You rarely need to call this alone; it is the default guard inside `purgeDownloadedModelArtifacts`. It is exposed so you can **merge** it with your own rules (see example below).

#### `purgeDownloadedModelArtifacts(options?)`

Deletes, across **all** categories:

1. **Completed** downloads (same effect as `deleteModelByCategory` per model)
2. **Incomplete downloads** (`deleteIncompleteDownload`)
3. **Incomplete extractions** (`deleteIncompleteExtraction`), and attempts to remove a leftover **archive** file for that model when present

**Options**

- `protectKeys?: ReadonlySet<string>` — Keys (`category:modelId`) to **never** delete. If omitted, defaults to `await getProtectedModelKeysForBulkDelete()`.

**Return value** (`PurgeDownloadedModelArtifactsResult`):

| Field | Meaning |
| --- | --- |
| `deletedComplete` | Fully downloaded models removed |
| `deletedIncompleteDownloads` | Partial download states cleaned |
| `deletedIncompleteExtractions` | Partial extraction states cleaned |
| `skippedProtected` | Rows skipped because the key was in the protected set |

#### Example: settings — clear everything safe

The default protected set avoids corrupting an active download or extraction:

```typescript
import { purgeDownloadedModelArtifacts } from 'react-native-sherpa-onnx/download';

async function onClearAllDownloadedModels() {
  const result = await purgeDownloadedModelArtifacts();
  console.log(
    'Removed complete:',
    result.deletedComplete,
    'skipped (in progress):',
    result.skippedProtected
  );
}
```

#### Example: also keep the model the user pinned as “favorite”

Build the protect set = automatic in-flight protection **plus** your own keys:

```typescript
import {
  ModelCategory,
  getProtectedModelKeysForBulkDelete,
  purgeDownloadedModelArtifacts,
} from 'react-native-sherpa-onnx/download';

async function purgeExceptPinned(pinnedModelIds: { category: ModelCategory; id: string }[]) {
  const protect = new Set(await getProtectedModelKeysForBulkDelete());
  for (const { category, id } of pinnedModelIds) {
    protect.add(`${category}:${id}`);
  }
  return purgeDownloadedModelArtifacts({ protectKeys: protect });
}
```

#### Example: force wipe (use with care)

Pass an **empty** set only if you are sure no download or extraction should survive (e.g. isolated test build); active operations may still fail unpredictably:

```typescript
await purgeDownloadedModelArtifacts({ protectKeys: new Set() });
```

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
  getProtectedModelKeysForBulkDelete,
  purgeDownloadedModelArtifacts,
  configureModelDownloadBackgroundDownloader,
} from 'react-native-sherpa-onnx/download';

import type {
  BackgroundDownloaderSetConfigOptions,
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
  PurgeDownloadedModelArtifactsResult,
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
| No Android download notification | Ensure **Android 13+**: `POST_NOTIFICATIONS` in the manifest **and** runtime grant; pull the shade during an active download. See [Android: foreground service & notifications](#android-foreground-service--notifications). |
| Play upload: foreground service declaration | Complete **App content** declarations in Play Console for merged `FOREGROUND_SERVICE*` permissions; see section above. |

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
