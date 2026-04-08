# Migration Guides

## TTS batch audio API update (`GeneratedAudio`)

`GeneratedAudio.samples` has been removed from the immediate return value.

| Before | After |
| --- | --- |
| `audio.samples.length` | `audio.numSamples` |
| `audio.samples` | `await audio.getSamples()` (`Float32Array`) |
| JS-side export from `saveAudio` call path | `saveAudio(audio, ...)` (sink-native path) |

## TTS release catalog metadata (native)

For **`react-native-sherpa-onnx/download`**, TTS **`ModelMeta`** fields **`type`**, **`languages`**, **`quantization`**, and **`sizeTier`** are filled from the native TurboModule **`detectTtsModel`** with an empty directory and the release **asset id** as **`assetName`** (name-only heuristics; no filesystem). After extraction, the model folder **basename equals the release asset id** (archive stem), which is what the native layer uses.

**`refreshModels(ModelCategory.Tts)`** resolves those fields with **one `detectTtsModel` call per asset id** (JavaScript loop; no native batch API).

The TurboModule methods **`batchTtsCatalogHints`** and **`nativeBatchTtsCatalogHints`** are removed. The export **`DEFAULT_TTS_CATALOG_HINTS_CHUNK_SIZE`** and the **`refreshModels`** option **`ttsCatalogHintsChunkSize`** are removed. Use **`SherpaOnnx.detectTtsModel(modelDir, assetName, modelType?)`** instead: pass **`''`** for `modelDir` and the release id string for `assetName` when you only need name-based catalog metadata.

## TTS `detectTtsModel` — `detectionSources` (additive)

Android and iOS share one native TTS detection implementation. The result map may include **`detectionSources`**: an array of short strings (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`) describing how the primary model kind was chosen. TypeScript exposes this as optional **`detectionSources?: readonly TtsDetectionSource[]`** on **`detectTtsModel`**. Existing callers can ignore it; narrowing uses **`isTtsDetectionSource`** when parsing unknown payloads.

## Unified TTS `saveAudio` (replacing `saveAudioToFile` / `saveAudioToContentUri`)

The module-level helpers **`saveAudioToFile`** and **`saveAudioToContentUri`** are removed. Use **`saveAudio`** with an explicit target:

| Before | After |
| --- | --- |
| `saveAudioToFile(audio, path)` | `saveAudio(audio, { kind: 'file', path })` |
| `saveAudioToContentUri(audio, directoryUri, filename)` | `saveAudio(audio, { kind: 'androidContent', directoryUri, filename })` (Android only) |

Optional third argument: **`{ format?: string; outputSampleRateHz?: number }`** — default `format` is `'wav'`. Non-WAV formats require FFmpeg (see [disable-ffmpeg.md](./disable-ffmpeg.md)).

TurboModule consumers: call **`saveTtsAudioFromPCM`** with flat arguments (`destinationType`: `'file'` | `'androidContent'`, `pathOrDirectoryUri`, `filename`, `format`, `outputSampleRateHz`).

## Files API (persistence & sharing helpers)

The following are **no longer** exported from **`react-native-sherpa-onnx/tts`**. Import them from **`react-native-sherpa-onnx/files`** (or `copyFileToContentUri` from the package root).

| Before | After |
| --- | --- |
| `import { saveTextToContentUri, … } from 'react-native-sherpa-onnx/tts'` | `import { saveTextToContentUri, … } from 'react-native-sherpa-onnx/files'` |
| `import { copyFileToContentUri } from 'react-native-sherpa-onnx/tts'` | `import { copyFileToContentUri } from 'react-native-sherpa-onnx/files'` (or from `'react-native-sherpa-onnx'`) |
| `import { copyContentUriToCache } from 'react-native-sherpa-onnx/tts'` | `import { copyContentUriToCache } from 'react-native-sherpa-onnx/files'` |
| `import { shareAudioFile } from 'react-native-sherpa-onnx/tts'` | `import { shareAudioFile } from 'react-native-sherpa-onnx/files'` |

**`saveAudio`** stays on **`react-native-sherpa-onnx/tts`** (unchanged).

### TurboModule (`NativeSherpaOnnx` / `SherpaOnnx`)

If you call the native module directly (bypassing the JS helpers), method names were renamed to match the **`files`** surface:

| Before | After |
| --- | --- |
| `saveTtsTextToContentUri` | `saveTextToContentUri` |
| `copyTtsContentUriToCache` | `copyContentUriToCache` |
| `shareTtsAudio` | `shareAudioFile` |
| `copyFileToContentUri` | *(unchanged)* |
| `saveTtsAudio` | `saveTtsAudioFromPCM` |

See [docs/files.md](./files.md).

## Breaking changes (upgrading to 0.3.0)

If you are upgrading from an earlier version to **0.3.0**, plan for the following migration steps.

### Instance-based API (TTS + STT)

TTS and STT now use an instance-based factory pattern instead of module-level singletons. Each call to `createTTS()` / `createSTT()` returns an independent engine instance. You **must** call `.destroy()` when done to free native resources.

**TTS Before:**

```ts
initializeTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const audio = await generateSpeech('Hello');
await unloadTTS();
```

**TTS After:**

```ts
const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const audio = await tts.generateSpeech('Hello');
await tts.destroy();
```

**STT Before:**

```ts
await initializeSTT({ modelPath: { type: 'asset', path: 'models/whisper' } });
const result = await transcribeFile('/audio.wav');
await unloadSTT();
```

**STT After:**

```ts
const stt = await createSTT({ modelPath: { type: 'asset', path: 'models/whisper' } });
const result = await stt.transcribeFile('/audio.wav');
await stt.destroy();
```

### Speech-to-Text (STT)

- **`transcribeFile`** now returns `Promise<SttRecognitionResult>` (an object with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, `durations`) instead of `Promise<string>`. For text only, use `(await transcribeFile(path)).text`.
- **`initializeSTT`** supports two additional optional options: `hotwordsFile` and `hotwordsScore`. The native TurboModule methods were renamed from `initializeSherpaOnnx` / `unloadSherpaOnnx` to `initializeStt` / `unloadStt`.
- **Removed deprecated type:** `TranscriptionResult` has been removed. Use `SttRecognitionResult` instead (same shape).

### Text-to-Speech (TTS)

- **Instance-based API:** Use `createTTS()` to get a `TtsEngine`; call `tts.generateSpeech()`, `tts.generateSpeechStream()`, etc., then `tts.destroy()`. See [Instance-based API (TTS + STT)](#instance-based-api-tts--stt) above. If you call the **TurboModule directly**, all instance-bound methods now take `instanceId` as the first parameter (see [docs/tts.md – Mapping to Native API](./docs/tts.md#mapping-to-native-api)).
- **TTS model-specific options (breaking for versions &lt; 0.3.0):**  
  Init and update no longer use flat `noiseScale`, `noiseScaleW`, and `lengthScale` on the options object. Use **`modelOptions`** instead, with one block per model type (aligned with the STT `modelOptions` design):
  - **`createTTS` (init):** Replace flat `noiseScale`, `noiseScaleW`, `lengthScale` with `modelOptions`. Only the block for the loaded model type is applied.  
    **Before (old API):** `initializeTTS({ modelPath, modelType: 'vits', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 })`  
    **After:** `createTTS({ modelPath, modelType: 'vits', modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } } })`
  - **`tts.updateParams`:** Replace flat `noiseScale` / `noiseScaleW` / `lengthScale` with `modelOptions` (and optionally `modelType`). When `modelType` is omitted, the engine uses the type from `createTTS()`.  
    **Before (old API):** `updateTtsParams({ noiseScale: 0.7, lengthScale: 1.2 })`  
    **After:** `tts.updateParams({ modelOptions: { vits: { noiseScale: 0.7, lengthScale: 1.2 } } })` or `tts.updateParams({ modelType: 'vits', modelOptions: { vits: { ... } } })`
  - Types: `TtsModelOptions`, `TtsVitsModelOptions`, `TtsMatchaModelOptions`, `TtsKokoroModelOptions`, `TtsKittenModelOptions`, `TtsPocketModelOptions` are exported from the TTS module. See [docs/tts.md](./docs/tts.md) for details.
- **Removed deprecated type:** `SynthesisOptions` has been removed. Use `TtsGenerationOptions` instead (same shape).

## Download Manager API (upgrading to 0.4.0)

This release redesigns the public download manager API for SDK consumers.

### Renamed Functions

| Before | After | Notes |
| --- | --- | --- |
| `ensureModelByCategory` | `ensureModel` | High-level flow unchanged |
| `refreshModelsByCategory` | `refreshModels` | |
| `listModelsByCategory` | `listModels` | |
| `getModelByIdByCategory` | `getModelById` | |
| `getModelsCacheStatusByCategory` | `getModelsCacheStatus` | |
| `clearModelCacheByCategory` | `clearModelsCache` | |
| `downloadModelByCategory` | `downloadModel` | |
| `extractModelByCategory` | `extractModel` | |
| `isModelDownloadedByCategory` | `isModelDownloaded` | |
| `getLocalModelPathByCategory` | `getModelPath` | |
| `listDownloadedModelsByCategory` | `listDownloadedModels` | |
| `deleteModelByCategory` | `deleteModel` | |
| `getDownloadStorageBase` | `getStorageBasePath` | |
| `subscribeDownloadProgress` | `onProgress` | Returns unsubscribe |
| `subscribeModelsListUpdated` | `onModelsListUpdated` | Returns unsubscribe |
| `configureModelDownloadBackgroundDownloader` | `configureBackgroundDownloader` | |
| `getProtectedModelKeysForBulkDelete` | `getProtectedKeys` | |
| `purgeDownloadedModelArtifacts` | `purgeAll` | |

### Added Functions

| New | Purpose |
| --- | --- |
| `pauseDownload(category, modelId)` | Explicitly pause an active download |
| `pauseExtraction(category, modelId)` | Explicitly pause an active extraction |

### Removed Exports

The following exports were removed from the public download manager surface:

- `extractTarBz2`
- `extractTarZst`
- `validateChecksum`
- `validateExtractedFiles`
- `resolveActualModelDir`
- `parseChecksumFile`
- `calculateFileChecksum`
- `setExpectedFilesForCategory`
- `getExpectedFilesForCategory`

### Type Changes

| Before | After |
| --- | --- |
| `ModelMetaBase` + `TtsModelMeta` | `ModelMeta` (single unified type, TTS fields optional) |
| `DownloadProgress` | `Progress` |
| `bytesDownloaded` | `bytesProcessed` |
| `ChecksumIssue` | `ChecksumMismatchInfo` |
| `onChecksumIssue` | `onChecksumMismatch` |

### New Pause / Resume Style

Pause no longer requires using `AbortController` as a pause mechanism.

**Before (pause via abort):**

```ts
const controller = new AbortController();

const run = downloadModelByCategory(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny', {
  signal: controller.signal,
});

controller.abort();
await run;
```

**After (explicit pause API):**

```ts
import { ModelCategory, PauseError, downloadModel, pauseDownload, resumeDownload } from 'react-native-sherpa-onnx/download';

const run = downloadModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');

await pauseDownload(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');

try {
  await run;
} catch (error) {
  if (!(error instanceof PauseError)) {
    throw error;
  }
}

await resumeDownload(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny');
```

### Before / After Examples

**Ensure model**

```ts
// Before
await ensureModelByCategory(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');

// After
await ensureModel(ModelCategory.Tts, 'vits-piper-en_US-lessac-medium');
```

**List downloaded models**

```ts
// Before
const installed = await listDownloadedModelsByCategory(ModelCategory.Alignment);

// After
const installed = await listDownloadedModels(ModelCategory.Alignment);
```

**Progress subscription**

```ts
// Before
const unsubscribe = subscribeDownloadProgress((category, modelId, progress) => {
  console.log(progress.bytesDownloaded);
});

// After
const unsubscribe = onProgress((category, modelId, progress) => {
  console.log(progress.bytesProcessed);
});
```

### Text-to-Speech: strict types (0.4.0)

The TTS public TypeScript surface uses **discriminated unions** so invalid combinations are caught at compile time. This is a **breaking change** for code that relied on the previous loose shapes.

| Topic | Before | After |
| --- | --- | --- |
| Init + `auto` | `modelType: 'auto'` (or omitted) with `modelOptions` | With `'auto'` or omitted `modelType`, **`modelOptions` is not allowed**. Set an explicit `modelType` (e.g. `'vits'`) to pass scales. |
| Init + concrete type | Any keys on `TtsModelOptions` | Only the block matching `modelType` (e.g. `modelType: 'vits'` + `modelOptions: { vits: { ... } }`). |
| `updateParams` | `modelOptions` without a strict tie to `modelType` | Same rules as init: use a variant with matching `modelType` and `modelOptions` (or `{}` / `{ modelType: 'auto' }` for no-op style updates). |
| Generation / cloning | Top-level `referenceAudio` / `referenceText` | Use **`voiceClone`**: `{ kind: 'zipvoice', referenceAudio, referenceText }` or `{ kind: 'pocket', referenceAudio, referenceText? }`. |
| Subtitles | `mode: 'fast'` | Renamed to **`proportional`**; **`estimated`** uses native chunk timeline; **`character`** only with `subtitles: { mode: 'accurate', alignmentModelPath: string, ... }`. For `off` / `proportional` / `estimated`, `alignmentModelPath` must not be set. |
| Standalone alignment | `generateSubtitlesFromAudio` | Removed; use **`alignTextToAudio`** from **`react-native-sherpa-onnx/alignment`**. **`accurate`** requires `alignmentModelPath`. **`proportional`** / **`estimated`** only allow `granularity: 'sentence' \| 'word'`. |

**Zipvoice example (`voiceClone`):**

```ts
await tts.generateSpeech('Hello', {
  voiceClone: {
    kind: 'zipvoice',
    referenceAudio: { samples, sampleRate },
    referenceText: 'Transcript of reference',
  },
});
```

See [docs/tts.md](./tts.md), [docs/tts-streaming.md](./tts-streaming.md), and [docs/alignment.md](./alignment.md) for updated option tables and standalone `alignTextToAudio`.

## Alignment: native low-I/O refactor (upcoming major; **no** backward compatibility)

A future **major** release will replace the current alignment stack with a native-first design (shared C++ CTC path, path-based proportional metrics, optional TTS→alignment without redundant I/O). **There will be no long-lived compatibility shims:** superseded TurboModule methods and obsolete JS exports are **removed** rather than deprecated.

**Who must read this**

- Callers of **`NativeSherpaOnnx`** alignment-related APIs **directly** (bypassing [`react-native-sherpa-onnx/alignment`](./alignment.md)).
- Anyone relying on **implementation details** that may disappear (e.g. alignment-only use of temp WAV helpers).

**Migration principles**

| Topic | Policy |
| --- | --- |
| TurboModule | **`runCTCForcedAlignment`** was removed. Use **`alignAccurateFromPath(modelPath, audioPath, text, vocabJson)`** for file-based CTC, or **`alignAccurateFromFloat32(modelPath, samples, sampleRate, text, vocabJson)`** when PCM is already in JS. For fast proportional duration on **16-bit mono WAV**, use **`getAlignmentAudioMetrics(audioPath)`**; see [alignment.md](./alignment.md). |
| Public JS | Prefer **`alignTextToAudio`** (and related types) from **`react-native-sherpa-onnx/alignment`** as the stable app-facing API. Its surface may change in the same major; there will be **no** parallel deprecated export set. |
| Docs | [alignment.md](./alignment.md) will describe the final APIs and performance expectations; this section will be tightened with **concrete** removed symbols at ship time. |

**At release time:** maintainers should (1) list every removed export and TurboModule method in **CHANGELOG**, (2) replace the placeholders in the table above with exact names, and (3) keep this guide in sync.

