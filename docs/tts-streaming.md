# Streaming Text-to-Speech (TTS)

Incremental speech generation with chunk callbacks: lower time-to-first-byte, playback while generating, or piping float PCM into another pipeline. The API is **instance-based** — create an engine with `createStreamingTTS()`, then call `destroy()` when done.

**For full-buffer synthesis, timestamps on the batch path, WAV save/share, and `alignTextToAudio`:** see [Offline TTS](tts-offline.md) and [alignment.md](alignment.md).

**Import path:** `react-native-sherpa-onnx/tts`

## Choosing a streaming path

| Goal | Use | Options |
|------|-----|---------|
| **Interactive playback (native, zero bridge PCM)** | `generateSpeechStream` | `playback: true, emitChunks: false` |
| **Interactive playback + waveform visualization** | `generateSpeechStream` | `playback: true, emitChunks: true` |
| **Chunks to JS only (manual player feed)** | `generateSpeechStream` | `playback: false, emitChunks: true` (default) |
| **Incremental text feeding** (progressive input) | `generateIncrementalSpeechStream` | `playback: false, emitChunks: true` (default) |
| **Long-text file export** (preferred) | `generateSpeechStreamToFile` | `emitChunks: false` (default) |
| **File export + live playback** | `generateSpeechStreamToFile` | `playback: true, emitChunks: false` |

**`generateSpeechStreamToFile`** is the preferred path for long text because all PCM stays in native memory. Set `emitChunks: true` only when you also need live playback or visualization during export.

## Models & paths

- **`ModelPathConfig`** (from `react-native-sherpa-onnx`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** below scans the model directory and returns kinds **without** initializing the engine (see [Detection](#detection)).

## Quick Start

### 1) Interactive playback / visualization (`generateSpeechStream`)

Use this path when you want real-time chunk handling in JS. This example shows the recommended pre-check with `detectTtsModel` before engine init.

```ts
import { createStreamingTTS, detectTtsModel } from 'react-native-sherpa-onnx/tts';

const modelPath = { type: 'asset' as const, path: 'models/vits-piper-en_US-lessac-medium' };
const det = await detectTtsModel(modelPath);
if (!det.success || det.modelType !== 'vits') {
  throw new Error(det.error ?? 'Expected a VITS model for this example');
}

const tts = await createStreamingTTS({
  modelPath,
  modelType: det.modelType,
  numThreads: 2,
  modelOptions: {
    vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 },
  },
});

// Native playback — no manual PCM player needed
const controller = await tts.generateSpeechStream(
  'Streaming hello.',
  { sid: 0, speed: 1.0 },
  {
    onChunk: (c) => {
      // chunks are only published if emitChunks: true
      // set emitChunks: false to reduce overhead if you only want to use the pcm player
      // c.samples, c.sampleRate, c.progress, c.isFinal
    },
    onEnd: () => {
      console.log('Playback finished');
    },
    onError: (e) => {
      console.error('Stream error:', e.message);
    },
  },
  { playback: true, emitChunks: true }
);

// Pause / resume during playback:
await controller.player?.pause();
await controller.player?.resume();

// Cancel stops synthesis + destroys player
await controller.cancel().catch(() => {});
await tts.destroy();
```

### 2) Long-text file export (preferred) (`generateSpeechStreamToFile`)

Preferred for long text because PCM stays native and is written incrementally to file.  
If needed, you can use `detectTtsModel` exactly like in example 1 before `createStreamingTTS`.

```ts
import { createStreamingTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({
  modelPath: { type: 'file', path: '/absolute/path/to/tts-model' },
});

const ctrl = await tts.generateSpeechStreamToFile(
  'Long text that should be exported directly.',
  { sid: 0, speed: 1.0 },
  {
    output: { kind: 'file', path: '/absolute/path/out.wav' },
    format: 'wav',
    keepPartialOnCancel: false,
    emitChunks: false,
  },
  {
    onEnd: (e) => {
      // e.path, e.bytesWritten, e.sampleRate, e.cancelled
    },
    onError: (e) => {
      // e.message
    },
  }
);

await ctrl.cancel().catch(() => {});
await tts.destroy();
```

### 3) File export + live playback (`generateSpeechStreamToFile` + `playback: true`)

Use when you need native file export and native audio playback at the same time.  
If needed, you can use `detectTtsModel` exactly like in example 1 before `createStreamingTTS`.

```ts
import { createStreamingTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({
  modelPath: { type: 'file', path: '/absolute/path/to/tts-model' },
});

const ctrl = await tts.generateSpeechStreamToFile(
  'Export and play while generating.',
  { sid: 0, speed: 1.0 },
  {
    output: { kind: 'file', path: '/absolute/path/out-with-monitor.wav' },
    format: 'wav',
    emitChunks: false,
  },
  {
    onEnd: (e) => {
      console.log(`Saved ${e.bytesWritten} bytes to ${e.path}`);
    },
    onError: (e) => {
      console.error('Stream error:', e.message);
    },
  },
  { playback: true }
);

// Pause / resume during playback:
await ctrl.player?.pause();
await ctrl.player?.resume();

await ctrl.cancel().catch(() => {});
await tts.destroy();
```

### 4) Incremental text feeding (`createIncrementalStreamingTTS`)

Use this path when text arrives progressively (chat/LLM typing).  
The engine batches text into segments and reuses the existing streaming path internally.

```ts
import { createIncrementalStreamingTTS } from 'react-native-sherpa-onnx/tts';

const inc = await createIncrementalStreamingTTS({
  source: {
    engineOptions: {
      modelPath: { type: 'asset', path: 'models/vits-piper-en_US-lessac-medium' },
    },
  },
  segmentation: {
    maxCharsPerSegment: 220,
    minCharsPerSegment: 24,
    maxWaitMs: 900,
  },
});

// Start one incremental request (request-centric API).
const ctrl = inc.generateIncrementalSpeechStream(
  { sid: 0, speed: 1.0 },
  {
    onSessionEvent: (e) => {
      // session:started | session:draining | session:idle | session:cancelled | session:error
      console.log(e.type);
    },
    onSegmentEvent: (e) => {
      // segment:queued | segment:started | segment:chunk | segment:ended | segment:dropped
      if (e.type === 'segment:dropped') console.warn(e.reason);
    },
    onError: (e) => {
      console.error('Incremental stream error:', e.message);
    },
  },
  // Native playback with minimal bridge traffic
  { playback: true, emitChunks: false }
);

// Push progressive text chunks
ctrl.pushText('Hallo Michael. ');
ctrl.pushText('Today, the weather was amazing. But tomorrow, I think it will rain instead. ');

// commit() is done automatically internally if auto-segmentation finds a boundary
// commit() is a force trigger: it enqueues the current buffer now, even without punctuation/timeout boundary.
// so use it only if you need to force enqueing
ctrl.commit();

// Wait until queue is drained
await ctrl.flush();

// Pause / resume during playback:
await ctrl.player?.pause();
await ctrl.player?.resume();

// Optional: cancel active + queued work
await ctrl.cancel({ scope: 'all' });
await inc.destroy();
```

**Note:** Zipvoice cloning is **not** supported in streaming on Android; Pocket cloning uses `voiceClone: { kind: 'pocket', referenceAudio: { samples, sampleRate } }`. For Zipvoice voice cloning use batch **`generateSpeech`** on the offline path — [tts-offline.md](tts-offline.md).

## Stream options (`TtsStreamOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `playback` | `boolean` | `false` | Enqueue PCM to native player automatically |
| `emitChunks` | `boolean` | `true` | Deliver `onChunk` callbacks with binary PCM |
| `autoDestroy` | `boolean` | `true` | Auto-destroy the internal player after `onEnd` fires |

**Invalid combination:** `playback: false` + `emitChunks: false` is a no-op. The current JS wrapper does **not** reject; it logs a warning and returns a no-op controller. Enable at least one of `playback` or `emitChunks`.

When `playback: true`, the streaming controller exposes `ctrl.player` — a `PcmPlayer` with `pause()`, `resume()`, and `destroy()`. See [pcm-player.md](pcm-player.md) for standalone player usage.

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` on init; check availability via root helpers (e.g. `getCoreMlSupport`) — [execution-providers.md](execution-providers.md) |
| Accurate subtitles | Alignment ONNX from `react-native-sherpa-onnx/alignment`; see [alignment.md](alignment.md) |
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
  detectedModels: { type: string; modelDir: string }[];
  modelType?: TTSModelType;
  // only available for Kokoro/Kitten; otherwise empty
  lexiconLanguageCandidates?: string[];
  languages?: { iso6391Hint: string; id: string }[];
  quantization?: string;
  sizeTier?: string;
  /** When present, how native code chose the model kind (e.g. `fileListing` after a scan, `dirName` from the folder name, `fallbackOrder`, `explicitModelType`, or `nameOnly` for the empty-file-list test path). */
  detectionSources?: readonly DetectionSource[];
}>;
```

File-based detection and validation **without** initializing the TTS engine: no native synthesizer is created, so this call is comparatively cheap and suitable as a **pre-check** before **`createStreamingTTS`** or **`createTTS`** — for example to obtain a concrete `modelType` (and Kokoro/Kitten `lexiconLanguageCandidates`) so you can pass the right `modelOptions` on init.

**`detectionSources`** is an optional, ordered trace of mechanisms used (stable string literals; see `DetectionSource` in `react-native-sherpa-onnx/tts`). The host-only **name-only** path (empty file list in C++ tests) never validates paths and is not used by production `detectTtsModel` after a real directory scan.

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

### `createIncrementalStreamingTTS(options)`

```ts
function createIncrementalStreamingTTS(
  options: IncrementalStreamingTtsFactoryOptions
): Promise<IncrementalStreamingTtsEngine>;
```

High-level incremental layer over `StreamingTtsEngine`.  
It handles buffering, boundary detection, queue policy, and serial dispatch.

```ts
const inc = await createIncrementalStreamingTTS({
  source: { engineOptions: { modelPath: { type: 'asset', path: 'models/my-tts-model' } } },
});
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
      // optional when emitChunks=true — use for waveform visualization etc.
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

### Standalone PCM player

For manual PCM playback (non-TTS audio, custom feed logic), use the standalone player from `react-native-sherpa-onnx/pcm`. See [pcm-player.md](pcm-player.md).

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

## Incremental engine (`IncrementalStreamingTtsEngine`)

### `inc.generateIncrementalSpeechStream(options, handlers, streamOptions?, incrementalOptions?)`

```ts
generateIncrementalSpeechStream(
  options: TtsGenerationOptions | undefined,
  handlers: IncrementalStreamHandlers,
  streamOptions?: TtsStreamOptions,
  incrementalOptions?: IncrementalRequestOptions
): IncrementalStreamController;
```

Starts one incremental request with chunk/playback behavior analogous to `generateSpeechStream`.  
Only one active request per engine instance at a time.

### `inc.generateIncrementalSpeechStreamToFile(options, fileOptions, handlers, incrementalOptions?)`

```ts
generateIncrementalSpeechStreamToFile(
  options: TtsGenerationOptions | undefined,
  fileOptions: TtsStreamToFileOptions,
  handlers: IncrementalStreamToFileHandlers,
  incrementalOptions?: IncrementalRequestOptions
): IncrementalStreamFileController;
```

Starts one incremental request writing to file (internally segmented and serialized).

### `inc.getModelInfo()`, `inc.getSampleRate()`, `inc.getNumSpeakers()`, `inc.destroy()`

Same semantics as `StreamingTtsEngine`.

## Incremental stream controller (`IncrementalStreamController`)

### `ctrl.pushText(text)`

```ts
pushText(text: string): void;
```

Adds incremental input text to the active request buffer. Auto-segmentation may enqueue new segments.

### `ctrl.commit(options?)`

```ts
commit(options?: CommitOptions): void;
```

`commit()` is a force trigger, not a required step for normal generation.

Behavior matrix:

- Only `pushText()` with detectable boundaries -> speech is generated automatically.
- `pushText()` without boundaries, but timeout enabled -> speech starts when timeout triggers forced segmentation.
- `pushText()` without boundaries and no timeout -> no generation until `commit()` or `flush()`.
- `commit()` -> immediate enqueue/start path for current buffered text.

### `ctrl.flush(options?)`

```ts
flush(options?: FlushOptions): Promise<void>;
```

Commits remaining buffer and resolves when queue + active segment are finished.

### `ctrl.cancel(options?)`

```ts
cancel(options?: CancelOptions): Promise<void>;
```

Cancels by scope:

- `all` (default): active + queued
- `active`: active only
- `queued`: queued only

### `ctrl.getMetrics()`

```ts
getMetrics(): IncrementalMetrics;
```

Returns a snapshot: queue depth, totals, and current active segment id.

### `ctrl.player`

`PcmPlayer | null` (non-null only when `streamOptions.playback === true`).

### `ctrl.state`

Current session state for this request.

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
| `GeneratedAudio` | `{ sampleRate: number; numSamples: number; generation: number; getSamples(): Promise<Float32Array> }` |
| `GeneratedAudioWithTimestamps` | Extends `GeneratedAudio` with `subtitles`, `timingMode` |
| `SubtitleTimingItem` | `{ text, start, end }` (seconds) |
| `TTSModelInfo` | `{ sampleRate, numSpeakers }` |
| `DetectedModelEntry` | `{ type: string; modelDir: string }` |
| `TtsStreamChunk` | `{ samples, sampleRate, progress, isFinal }` + optional `instanceId`, `requestId` |
| `TtsStreamEnd` | `{ cancelled: boolean }` + optional `instanceId`, `requestId` |
| `TtsStreamError` | `{ message: string }` + optional `instanceId`, `requestId` |
| `TtsStreamHandlers` | `{ onChunk?: (chunk: TtsStreamChunk) => void; onEnd?: (e: TtsStreamEnd) => void; onError?: (e: TtsStreamError) => void }` |
| `TtsStreamOptions` | `{ playback?, emitChunks?, autoDestroy? }` |
| `TtsStreamController` | `cancel()`, `unsubscribe()`, `player: PcmPlayer \| null` |
| `PcmPlayer` | `writePcmChunk()`, `pause()`, `resume()`, `destroy()` — see [pcm-player.md](pcm-player.md) |
| `TtsStreamFileOutput` | `{ kind: 'file'; path: string }` |
| `TtsStreamToFileOptions` | `{ output, format?: 'wav', keepPartialOnCancel?, emitChunks? }` |
| `TtsStreamFileEnd` | `{ path, bytesWritten, sampleRate, cancelled }` + optional ids |
| `TtsStreamFileError` | `{ message, path? }` + optional ids |
| `TtsStreamToFileHandlers` | `{ onChunk?, onEnd?: (e: TtsStreamFileEnd), onError?: (e: TtsStreamFileError) }` |
| `TtsStreamFileController` | `cancel()`, `unsubscribe()` |
| `ModelPathConfig` | From `react-native-sherpa-onnx` |

### Incremental streaming

| Type | Notes |
| --- | --- |
| `IncrementalStreamingTtsEngine` | `generateIncrementalSpeechStream`, `generateIncrementalSpeechStreamToFile`, `getModelInfo`, `getSampleRate`, `getNumSpeakers`, `destroy` |
| `IncrementalStreamingTtsFactoryOptions` | `{ source, segmentation?, queue? }` |
| `IncrementalStreamingTtsSource` | `{ engine: StreamingTtsEngine }` or `{ engineOptions: TTSInitializeOptions \| ModelPathConfig }` |
| `IncrementalRequestOptions` | `{ segmentation?, queue? }` |
| `IncrementalStreamHandlers` | `TtsStreamHandlers` + `onSessionEvent?`, `onSegmentEvent?`, `onMetrics?` |
| `IncrementalStreamToFileHandlers` | `TtsStreamToFileHandlers` + `onSessionEvent?`, `onSegmentEvent?`, `onMetrics?` |
| `IncrementalStreamController` | `pushText`, `commit`, `flush`, `cancel`, `getMetrics`, `player`, `state` |
| `IncrementalStreamFileController` | `pushText`, `commit`, `flush`, `cancel`, `getMetrics`, `state` |
| `SegmentationPolicy` | `boundaryChars?`, `maxCharsPerSegment?`, `maxWaitMs?`, `minCharsPerSegment?`, `debounceMs?` |
| `QueuePolicy` | `mode?`, `maxSegments?`, `maxBufferedChars?`, `overflowStrategy?` |
| `QueueMode` | `'fifo' \| 'replace-tail' \| 'latest-wins'` |
| `OverflowStrategy` | `'drop-oldest' \| 'drop-newest' \| 'reject'` |
| `CommitOptions` | `{ force?: boolean }` |
| `CancelOptions` | `{ scope?: 'all' \| 'active' \| 'queued' }` |
| `IncrementalMetrics` | `{ queueDepth, totalSegmentsQueued, totalSegmentsCompleted, totalSegmentsDropped, totalSegmentsReplaced, activeSegmentId }` |
| `SessionEvent` | `session:started`, `session:idle`, `session:draining`, `session:cancelled`, `session:error` |
| `SegmentEvent` | `segment:queued`, `segment:started`, `segment:chunk`, `segment:ended`, `segment:dropped` |

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
| `SubtitleMode` | `'off' \| 'proportional' \| 'estimated' \| 'accurate'` |
| `SubtitleGranularity` | `'sentence' \| 'word' \| 'character'` (character only with accurate) |
| `SubtitleOptions` | Proportional/estimated vs accurate (see TypeScript unions in `tts`) |
| Standalone alignment | `AlignTextToAudioOptions`, `AlignTextToAudioResult` in `react-native-sherpa-onnx/alignment` |

Breaking type history: [migration.md](migration.md) → **Text-to-Speech: strict types (0.4.0)** under the 0.4.0 section.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ALIGNMENT_MODEL_MISSING` | `accurate` without `alignmentModelPath` | Pass absolute path to wav2vec2 ONNX; see [alignment.md](alignment.md) |
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
- [pcm-player.md](pcm-player.md) — standalone PCM player  
- [alignment.md](alignment.md) — alignment models, `alignTextToAudio`, accurate subtitles  
- [execution-providers.md](execution-providers.md) — ORT execution providers  
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)  
- [migration.md](migration.md) — strict TTS TypeScript unions (0.4.0)
