# Streaming Text-to-Speech (TTS)

Incremental speech generation with chunk callbacks: lower time-to-first-byte, playback while generating, or piping float PCM into another pipeline. The API is **instance-based** — create an engine with `createStreamingTTS()`, then call `destroy()` when done.

**For full-buffer synthesis, timestamps on the batch path, WAV save/share, and `generateSubtitlesFromAudio`:** see [Offline TTS](tts-offline.md).

**Import path:** `react-native-sherpa-onnx/tts`

## Models & paths

- **`ModelPathConfig`** (from `react-native-sherpa-onnx`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** below scans the model directory and returns kinds **without** initializing the engine (see [Detection](#detection)).

## Quick Start

### 1) Streaming: chunks + optional native PCM player

```ts
import { createStreamingTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({
  modelPath: { type: 'asset', path: 'models/my-tts-model' },
});

const sampleRate = await tts.getSampleRate();
await tts.startPcmPlayer(sampleRate, 1);

const controller = await tts.generateSpeechStream(
  'Streaming hello.',
  { sid: 0, speed: 1.0 },
  {
    onChunk: (chunk) => {
      if (chunk.samples.length) void tts.writePcmChunk(chunk.samples);
    },
    onEnd: (e) => {
      void tts.stopPcmPlayer();
      // e.cancelled is true if the stream ended after cancellation
    },
    onError: (e) => {
      void tts.stopPcmPlayer();
      // e.message — native error string
    },
  }
);

await controller.cancel().catch(() => {});
await tts.destroy();
```

**Note:** Zipvoice cloning is **not** supported in streaming on Android; Pocket cloning uses `voiceClone: { kind: 'pocket', referenceAudio: { samples, sampleRate } }`. For Zipvoice voice cloning use batch **`generateSpeech`** on the offline path — [tts-offline.md](tts-offline.md).

### 2) Detect first, then streaming (explicit `modelType` / `modelOptions`)

Same idea as [Offline TTS Quick Start §1](tts-offline.md#1-batch-create-engine-synthesize-destroy): call **`detectTtsModel`** first so you get a narrowed **`modelType`** (and optional Kokoro/Kitten **`lexiconLanguageCandidates`**) without loading the synthesizer, then pass **`modelType`** into **`createStreamingTTS`** when you need engine-specific **`modelOptions`**.

```ts
import { createStreamingTTS, detectTtsModel } from 'react-native-sherpa-onnx/tts';

const det = await detectTtsModel({ type: 'asset', path: 'models/my-tts-model' });
if (!det.success || !det.modelType) {
  throw new Error(det.error ?? 'TTS model detection failed');
}

const tts = await createStreamingTTS({
  modelPath: { type: 'asset', path: 'models/my-tts-model' },
  modelType: det.modelType,
  numThreads: 2,
});

// … generateSpeechStream, PCM player, destroy — as in §1 above
await tts.destroy();
```

`modelType: 'auto'` (or omitted `modelType`) on **`createStreamingTTS`** still auto-detects on init, but **`modelOptions`** is not available in that mode — set an explicit `modelType` (e.g. from detection) first.

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` on init; check availability via root helpers (e.g. `getCoreMlSupport`) — [execution-providers.md](execution-providers.md) |
| Accurate subtitles | Alignment ONNX from `react-native-sherpa-onnx/alignment`; see [tts-alignment.md](tts-alignment.md) |
| Multi-instance | Each `createTTS` / `createStreamingTTS` gets a unique native `instanceId`; do not use an engine after `destroy()` |

## API Reference

Each entry below uses a one-line TypeScript signature (exported names match `react-native-sherpa-onnx/tts`). `ModelPathConfig` is imported from `react-native-sherpa-onnx` when you use the path-only `createStreamingTTS` shorthand.

## Detection

### `detectTtsModel(modelPath, options?)`

```ts
function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  error?: string;
  detectedModels: TtsDetectedModelEntry[];
  modelType?: TTSModelType;
  // only available for Kokoro/Kitten; otherwise empty
  lexiconLanguageCandidates?: string[];
  /** When present, how native code chose the model kind (e.g. `fileListing` after a scan, `dirName` from the folder name, `fallbackOrder`, `explicitModelType`, or `nameOnly` for the empty-file-list test path). */
  detectionSources?: readonly TtsDetectionSource[];
}>;
```

File-based detection and validation **without** initializing the TTS engine: no native synthesizer is created, so this call is comparatively cheap and suitable as a **pre-check** before **`createStreamingTTS`** or **`createTTS`** — for example to obtain a concrete `modelType` (and Kokoro/Kitten `lexiconLanguageCandidates`) so you can pass the right `modelOptions` on init.

**`detectionSources`** is an optional, ordered trace of mechanisms used (stable string literals; see `TtsDetectionSource` in `react-native-sherpa-onnx/tts`). The host-only **name-only** path (empty file list in C++ tests) never validates paths and is not used by production `detectTtsModel` after a real directory scan.

```ts
const result = await detectTtsModel({ type: 'asset', path: 'models/my-tts-model' });
if (!result.success) console.warn(result.error);
```

## Factories

### `createStreamingTTS(options)`

```ts
function createStreamingTTS(options: TTSInitializeOptions | ModelPathConfig): Promise<StreamingTtsEngine>;
```

Creates a **streaming** TTS engine. Same init union as [`createTTS`](tts-offline.md#createttsoptions); call `destroy()` when finished.

```ts
const tts = await createStreamingTTS({ modelPath: { type: 'file', path: '/path/to/model' } });
```

## Streaming engine (`StreamingTtsEngine`)

### `tts.generateSpeechStream(text, options, handlers)`

```ts
generateSpeechStream(
  text: string,
  options: TtsGenerationOptions | undefined,
  handlers: TtsStreamHandlers
): Promise<TtsStreamController>;
```

Starts streaming synthesis; events are delivered to `handlers`. Only one stream per engine at a time.

```ts
const ctrl = await tts.generateSpeechStream('Hi', undefined, {
  onChunk: (c) => {
    // c.samples, c.sampleRate, c.progress, c.isFinal
  },
  onEnd: (e) => {
    // e.cancelled
  },
  onError: (e) => {
    // e.message
  },
});
```

### `tts.generateSpeechStreamToFile(text, options, fileOptions, handlers)`

```ts
generateSpeechStreamToFile(
  text: string,
  options: TtsGenerationOptions | undefined,
  fileOptions: TtsStreamToFileOptions,
  handlers: TtsStreamToFileHandlers
): Promise<TtsStreamFileController>;
```

Streams synthesis directly to a native file sink (v1: WAV). Use this mode for long texts to avoid collecting all samples in JS memory.

```ts
const ctrl = await tts.generateSpeechStreamToFile(
  'Save this stream.',
  undefined,
  {
    output: { kind: 'file', path: '/absolute/path/out.wav' },
    format: 'wav',
    keepPartialOnCancel: false,
    emitChunks: true,
  },
  {
    onChunk: (c) => {
      // optional when emitChunks=true
      void tts.writePcmChunk(c.samples);
    },
    onEnd: (e) => {
      // e.path, e.bytesWritten, e.sampleRate, e.cancelled
    },
    onError: (e) => {
      // e.message, e.path?
    },
  }
);
```

### `tts.cancelSpeechStream()`

```ts
cancelSpeechStream(): Promise<void>;
```

Cancels the current stream from the engine side.

```ts
await tts.cancelSpeechStream();
```

### `tts.startPcmPlayer(sampleRate, channels)`

```ts
startPcmPlayer(sampleRate: number, channels: number): Promise<void>;
```

Starts built-in PCM playback (e.g. play-while-generating).

```ts
await tts.startPcmPlayer(22050, 1);
```

### `tts.writePcmChunk(samples)`

```ts
writePcmChunk(samples: number[]): Promise<void>;
```

Writes float PCM [-1, 1] to the player (typically from `onChunk`).

```ts
await tts.writePcmChunk(chunk.samples);
```

### `tts.stopPcmPlayer()`

```ts
stopPcmPlayer(): Promise<void>;
```

```ts
await tts.stopPcmPlayer();
```

### `tts.getModelInfo()` (streaming)

```ts
getModelInfo(): Promise<TTSModelInfo>;
```

Same as batch engine.

### `tts.getSampleRate()` (streaming)

```ts
getSampleRate(): Promise<number>;
```

### `tts.getNumSpeakers()` (streaming)

```ts
getNumSpeakers(): Promise<number>;
```

### `tts.destroy()` (streaming)

```ts
destroy(): Promise<void>;
```

## Stream controller (`TtsStreamController`)

### `controller.cancel()`

```ts
cancel(): Promise<void>;
```

Cancels the ongoing generation and unsubscribes listeners.

```ts
await controller.cancel();
```

### `controller.unsubscribe()`

```ts
unsubscribe(): void;
```

Removes event listeners (also called automatically on end/error).

```ts
controller.unsubscribe();
```

## Types

### Core

| Type | Notes |
| --- | --- |
| `TTSModelType` | `'vits' \| 'matcha' \| 'kokoro' \| 'kitten' \| 'pocket' \| 'zipvoice' \| 'supertonic' \| 'auto'` |
| `TTS_MODEL_TYPES` | Readonly list of model type literals |
| `TtsEngine` | Batch engine interface |
| `StreamingTtsEngine` | Streaming engine interface |
| `GeneratedAudio` | `{ samples: number[]; sampleRate: number }` |
| `GeneratedAudioWithTimestamps` | Extends `GeneratedAudio` with `subtitles`, `timingMode` |
| `TtsSubtitleItem` | `{ text, start, end }` (seconds) |
| `TTSModelInfo` | `{ sampleRate, numSpeakers }` |
| `TtsDetectedModelEntry` | `{ type: TTSModelType \| string; modelDir: string }` |
| `TtsStreamChunk` | `{ samples, sampleRate, progress, isFinal }` + optional `instanceId`, `requestId` |
| `TtsStreamEnd` | `{ cancelled: boolean }` + optional `instanceId`, `requestId` |
| `TtsStreamError` | `{ message: string }` + optional `instanceId`, `requestId` |
| `TtsStreamHandlers` | `{ onChunk?: (chunk: TtsStreamChunk) => void; onEnd?: (e: TtsStreamEnd) => void; onError?: (e: TtsStreamError) => void }` |
| `TtsStreamController` | `cancel()`, `unsubscribe()` |
| `TtsStreamFileOutput` | `{ kind: 'file'; path: string }` |
| `TtsStreamToFileOptions` | `{ output, format?: 'wav', keepPartialOnCancel?, emitChunks? }` |
| `TtsStreamFileEnd` | `{ path, bytesWritten, sampleRate, cancelled }` + optional ids |
| `TtsStreamFileError` | `{ message, path? }` + optional ids |
| `TtsStreamToFileHandlers` | `{ onChunk?, onEnd?: (e: TtsStreamFileEnd), onError?: (e: TtsStreamFileError) }` |
| `TtsStreamFileController` | `cancel()`, `unsubscribe()` |
| `ModelPathConfig` | From `react-native-sherpa-onnx` |

### Init, update, generation

| Type | Notes |
| --- | --- |
| `TTSInitializeOptions` | Discriminated union: with `modelType` omitted/`'auto'`, **`modelOptions` is disallowed**; otherwise only the matching `modelOptions` key (`vits`, `matcha`, …) |
| `TTSInitializeOptionsBase` | Shared fields: `modelPath`, `provider?`, `numThreads?`, `debug?`, `ruleFsts?`, `ruleFars?`, `maxNumSentences?`, `silenceScale?` |
| `TtsUpdateOptions` | Union including `{}` and per-`modelType` variants (same coupling rules as init) |
| `TtsGenerationOptions` | Base fields + optional **`voiceClone`**: `{ kind: 'zipvoice', referenceAudio, referenceText }` or `{ kind: 'pocket', referenceAudio, referenceText? }` |
| `TtsReferenceAudio` | `{ samples: number[]; sampleRate: number }` |
| `TtsVoiceClone` / `TtsVoiceCloneZipvoice` / `TtsVoiceClonePocket` | Cloning discriminant types |
| `TtsExecutionProvider` | `'cpu' \| 'coreml' \| 'xnnpack' \| 'nnapi' \| 'qnn' \| (string & {})` |
| `TtsModelOptions` | Internal aggregate for native flattening; prefer init/update unions in app code |
| `TtsVitsModelOptions`, `TtsMatchaModelOptions`, … | Per-architecture scale options |

### Subtitles

| Type | Notes |
| --- | --- |
| `SubtitleMode` | `'off' \| 'fast' \| 'accurate'` |
| `SubtitleGranularity` | `'sentence' \| 'word' \| 'character'` (character only with accurate) |
| `SubtitleOptions` | `SubtitleOptionsFast` \| `SubtitleOptionsAccurate` |
| `SubtitleFromAudioOptions` | `mode: 'fast'` vs `mode: 'accurate'` + required `alignmentModelPath` when accurate |
| `SubtitleResult` | `{ subtitles: TtsSubtitleItem[]; timingMode: 'estimated' \| 'aligned' }` |

Breaking type history: [migration.md](migration.md) → **Text-to-Speech: strict types (0.4.0)** under the 0.4.0 section.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ALIGNMENT_MODEL_MISSING` | `accurate` without `alignmentModelPath` | Pass absolute path to wav2vec2 ONNX; see [tts-alignment.md](tts-alignment.md) |
| `TTS_GENERATE_ERROR` / cloning | `voiceClone` on non–Zipvoice/Pocket model | Remove `voiceClone` or switch model |
| Zipvoice clone fails | Missing / empty `referenceText` | Use `voiceClone: { kind: 'zipvoice', referenceAudio, referenceText }` with non-empty text |
| Init throws with `modelOptions` | `modelType` is `'auto'` or omitted | Set explicit `modelType` before passing `modelOptions` |
| Methods throw after `destroy` | Engine already released | Create a new engine |
| Streaming error on Android + Zipvoice + ref audio | Unsupported combination | Use batch `generateSpeech` for Zipvoice cloning |
| `generateSpeechStreamToFile` fails with format error | Non-WAV format requested | Use `format: 'wav'` for v1 stream-to-file |
| Wrong or slow inference | Provider not built / unavailable | Check [execution-providers.md](execution-providers.md) and native logs |

## Mapping to Native API

If you call the **`NativeSherpaOnnx`** TurboModule directly instead of `createTTS()` / `createStreamingTTS()`, instance-bound TTS methods take **`instanceId`** as the first argument. Prefer the factory APIs in this document unless you manage native instances yourself.

## See also

- [tts-offline.md](tts-offline.md) — batch TTS, timestamps, save/share, standalone subtitles  
- [tts-alignment.md](tts-alignment.md) — alignment models, accurate subtitles  
- [execution-providers.md](execution-providers.md) — ORT execution providers  
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)  
- [migration.md](migration.md) — strict TTS TypeScript unions (0.4.0)
