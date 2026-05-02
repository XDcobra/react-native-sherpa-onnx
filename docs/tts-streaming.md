# Streaming Text-to-Speech (TTS)

## Introduction

Pipeline-based streaming TTS: a native background worker drains text segments from a `LiveTextBuffer`, synthesizes each segment, and writes PCM samples to a `LiveAudioBuffer`. **Audio data never crosses the JS bridge during steady-state** — JS only orchestrates start/stop/status.

**For full-buffer synthesis, timestamps, and WAV save/share:** see [Offline TTS](tts-offline.md). **Streaming + subtitles:** see [Subtitles](#subtitles) and [alignment-offline.md](alignment-offline.md).

**Import path:** `react-native-sherpa-onnx/tts`

## Architecture

```text
Text input ──→ LiveTextBuffer ──→ [TTS Pipeline Worker] ──→ LiveAudioBuffer ──→ downstream
                                   (native thread)
```

The TTS pipeline worker:
1. Creates a text cursor on the input `LiveTextBuffer`.
2. Blocks (condition variable) until new committed segments arrive.
3. For each segment, resolves `sid`/`speed` from per-segment `meta` (falls back to pipeline defaults), then calls `tts.Generate(text, sid, speed, chunkCallback)`.
4. The chunk callback writes PCM directly to the output `LiveAudioBuffer` — zero JS bridge traffic.
5. When the input text buffer is finalized and all segments are drained, the worker auto-stops.

Downstream consumers (enhancement pipeline, PCM player, STT pipeline, WAV export) read audio from the output buffer **in parallel** while TTS is still producing. True streaming parallelism across stages.

```text
LiveTextBuffer ──→ [Streaming TTS] ──→ LiveAudioBuffer₁ ──→ [Enhancement] ──→ LiveAudioBuffer₂ ──→ [Streaming STT]
```

## Models & paths

- **`ModelPathConfig`** (from `react-native-sherpa-onnx/fileio`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** below accepts a `FileSource` and returns kinds **without** initializing the engine (see [Detection](#detection)).

## Quick start

### 1) Direct pipeline control (`synthesize`)

Use when you manage text segments and audio buffers yourself.

```ts
import {
  createStreamingTTS,
  detectTtsModel,
  createLiveTextBuffer,
  createEmptyLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/tts';

const modelPath = { type: 'asset' as const, path: 'models/vits-piper-en_US-lessac-medium' };
const det = await detectTtsModel({ kind: 'app', base: 'files', path: 'models/vits-piper-en_US-lessac-medium' });
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

// Create buffers
const sampleRate = await tts.getSampleRate();
const textIn = await createLiveTextBuffer();
const audioOut = await createEmptyLiveAudioBuffer({
  sampleRate,
  channelCount: 1,
});

// Start native pipeline
const pipeline = await tts.synthesize(textIn, audioOut, {
  sid: 0,
  speed: 1.0,
});

// Push text segments (pipeline synthesizes each as it arrives)
await appendLiveTextSegment(textIn, 'Hello world. ');
await appendLiveTextSegment(textIn, 'How are you today?');

// Signal no more text
await finalizeLiveTextBuffer(textIn);

// Wait for pipeline to finish processing all segments
await pipeline.flush();

// Finalize audio buffer (if downstream consumers need an end signal)
await finalizeLiveAudioBuffer(audioOut);

// Cleanup
await pipeline.stop();
await tts.destroy();
```

### 2) Per-segment metadata overrides

Override `sid` and `speed` per segment via the `meta` parameter:

```ts
// Different speaker for each segment
await appendLiveTextSegment(textIn, 'Hello!', undefined, undefined, { sid: 0, speed: 1.0 });
await appendLiveTextSegment(textIn, 'Hi there!', undefined, undefined, { sid: 1, speed: 0.9 });
```

The worker resolves per call:
```
effectiveSid   = segment.meta.sid   ?? pipelineOptions.sid   ?? 0
effectiveSpeed = segment.meta.speed ?? pipelineOptions.speed ?? 1.0
```

### 3) Pipeline with voice cloning

Voice cloning reference audio is loaded **once** at pipeline start and reused for all segments.

```ts
const pipeline = await tts.synthesize(textIn, audioOut, {
  sid: 0,
  speed: 1.0,
  voiceClone: {
    kind: 'pocket',
    referenceAudio: offlineAudioBufferRef, // OfflineAudioBufferRef or string bufferId
  },
});
```

**Note:** Zipvoice cloning requires `referenceText` and is **not** supported in streaming on Android. For Zipvoice voice cloning, use batch `generateSpeech` on the offline path — [tts-offline.md](tts-offline.md).

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` on init; check availability via `react-native-sherpa-onnx/provider` (e.g. `getCoreMlSupport`) — [execution-providers.md](execution-providers.md) |
| Subtitles + streaming | Not on the streaming API surface — finish synthesis, then **`alignTextToAudio`**; see [Subtitles](#subtitles) and [alignment-offline.md](alignment-offline.md) |
| Multi-instance | Each `createStreamingTTS` gets a unique native `instanceId`; do not use an engine after `destroy()` |
| One pipeline per engine | `synthesize()` rejects with `TTS_PIPELINE_ALREADY_RUNNING` if a pipeline is already active on the same engine |
| Sample rate match | `audioOut.sampleRate` must equal the TTS model's output sample rate (strict — no hidden resampling) |

## API reference

## Detection

### `detectTtsModel(source, options?)`

```ts
function detectTtsModel(
  source: FileSource,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  error?: string;
  detectedModels: { type: string; modelDir: string }[];
  modelType?: TTSModelType;
  isStreaming: boolean;
  lexiconLanguageCandidates?: string[];
  languages?: { iso6391Hint: string; id: string }[];
  quantization?: string;
  sizeTier?: string;
  detectionSources?: readonly DetectionSource[];
}>;
```

File-based detection and validation **without** initializing the TTS engine: no native synthesizer is created, so this call is comparatively cheap and suitable as a **pre-check** before **`createStreamingTTS`** or **`createTTS`** — for example to obtain a concrete `modelType` (and Kokoro/Kitten `lexiconLanguageCandidates`) so you can pass the right `modelOptions` on init.

For TTS detections, `isStreaming` is always `true`.

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

```ts
const result = await detectTtsModel({ kind: 'fs', path: '/absolute/path/to/my-tts-model' });
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

For `createIncrementalStreamingTTS(options)`, see [API reference](#api-reference).

## Streaming engine (`StreamingTtsEngine`)

### `tts.synthesize(textIn, audioOut, options?)`

```ts
synthesize(
  textIn: LiveTextBufferIdSource,
  audioOut: LiveAudioBufferIdSource,
  options?: TtsPipelineOptions,
): Promise<TtsPipelineHandle>;
```

Starts a native streaming TTS pipeline. A dedicated background worker thread drains committed text segments from `textIn`, synthesizes each segment, and writes PCM samples to `audioOut`.

- `textIn` must be a live text buffer in `recording` state.
- `audioOut` must be a live audio buffer in `recording` state.
- `audioOut.sampleRate` must equal the TTS model's sample rate.
- Only **one pipeline per engine** at a time.

Returns a `TtsPipelineHandle` to control the running pipeline.

```ts
const pipeline = await tts.synthesize(textIn, audioOut, { sid: 0, speed: 1.0 });
```

### `tts.getModelInfo()` / `tts.getSampleRate()` / `tts.getNumSpeakers()`

```ts
getModelInfo(): Promise<TTSModelInfo>;
getSampleRate(): Promise<number>;
getNumSpeakers(): Promise<number>;
```

### `tts.destroy()`

```ts
destroy(): Promise<void>;
```

Stops any running pipeline, then releases native TTS resources. Do not use the engine after this.

## Pipeline handle (`TtsPipelineHandle`)

Returned by `tts.synthesize()`. Extends `StreamingPipelineHandle`.

### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

Stops the pipeline. If a segment is currently being synthesized, the chunk callback signals cancellation — sherpa-onnx aborts the current generation. Partial audio already written to the output buffer remains (valid prefix). Worker thread exits cleanly.

### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

Waits for the currently synthesizing segment to complete, then drains and synthesizes all remaining queued segments. Promise resolves when all current segments are processed. The pipeline **continues running** after flush.

### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

Discards queued (unprocessed) segments by advancing the cursor past all available segments. If a segment is currently being synthesized, it completes (no mid-generation cancel). The pipeline **continues running** — subsequent commits are processed normally.

### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

Returns pipeline metrics:

```ts
interface StreamingPipelineStatus {
  pipelineId: string;
  isRunning: boolean;
  chunksProcessed: number;  // segments completed
  unitsRead: number;        // characters consumed
  unitsWritten: number;     // audio samples produced
  error: string | null;
}
```

### `pipeline.pipelineId`

Readonly string identifier for this pipeline instance.

### `pipeline.instanceId`

Readonly string — the TTS engine instance driving this pipeline.

## Pipeline options (`TtsPipelineOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sid` | `number` | `0` | Speaker ID (overridable per-segment via `meta.sid`) |
| `speed` | `number` | `1.0` | Speed multiplier (overridable per-segment via `meta.speed`) |
| `voiceClone` | `TtsVoiceClone` | — | Voice cloning config; set once for the entire pipeline |

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| App text commits | `LiveTextBuffer` (`txt_live_*`) | Append segments progressively for low-latency speech start. |
| Streaming STT output | `LiveTextBuffer` (`txt_live_*`) | Real-time speech-to-speech pattern with committed segments. |
| Streaming punctuation output | `LiveTextBuffer` (`txt_live_*`) | Improves readability before speech generation. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Live synthesized audio | `LiveAudioBuffer` (`live_*`) | Primary streaming output for real-time playback. |
| PCM playback | `PcmPlayer` | Play while synthesis is still running. |
| Finalized audio artifact | finalize/convert to `OfflineAudioBuffer` | Optional post-run export/save path. |

```mermaid
flowchart LR
  A[LiveTextBuffer] --> B[createStreamingTTS().synthesize]
  B --> C[LiveAudioBuffer]
  C --> D[PCM playback or finalize for export]
```

More end-to-end patterns: [feature-pipelines.md#tts-streaming-patterns](feature-pipelines.md#tts-streaming-patterns).

## Types

Listed types are those used by **streaming TTS** in this document. Batch-only types (`TtsEngine`, `GeneratedAudio`, `GeneratedAudioWithTimestamps`, save helpers, `TtsUpdateOptions`, `SubtitleOptions`, …) are in [tts-offline.md](tts-offline.md). `ModelPathConfig` is imported from `react-native-sherpa-onnx/fileio`.

### Detection & model path

| Type | Notes |
| --- | --- |
| `ModelPathConfig` | `{ type: 'asset' \| 'file' \| 'auto'; path: string }` |
| `FileSource` | `{ kind: 'fs' \| 'app' \| 'contentUri' \| 'securityScoped' \| 'pad', ... }` |
| `TTSModelType` | `'vits' \| 'matcha' \| 'kokoro' \| 'kitten' \| 'pocket' \| 'zipvoice' \| 'supertonic' \| 'auto'` |
| `TTS_MODEL_TYPES` | Readonly list of model type literals |
| `isTtsModelType` | Runtime guard for `TTSModelType` |
| `TtsDetectModelResult` | Return type of `detectTtsModel()` |
| `DetectedModelEntry` | `{ type: string; modelDir: string }` |
| `DetectionSource` | Trace literals from native detection |

### Init

**`TtsUpdateOptions`** / `updateParams` are **batch-only** ([tts-offline.md](tts-offline.md)); `StreamingTtsEngine` does not expose parameter updates.

| Type | Notes |
| --- | --- |
| `TTSInitializeOptions` | `createStreamingTTS()` — with `modelType` omitted/`'auto'`, **`modelOptions` is disallowed** |
| `TTSInitializeOptionsBase` | Shared fields: `modelPath`, `provider?`, `numThreads?`, `debug?`, `ruleFsts?`, `ruleFars?`, `maxNumSentences?`, `silenceScale?` |
| `TtsVoiceClone` / `TtsVoiceCloneZipvoice` / `TtsVoiceClonePocket` | Cloning discriminant types |
| `TtsExecutionProvider` | `'cpu' \| 'coreml' \| 'xnnpack' \| 'nnapi' \| 'qnn' \| (string & {})` |
| `TtsModelOptions` | Internal aggregate for native flattening; prefer init unions in app code |
| `TtsVitsModelOptions`, `TtsMatchaModelOptions`, … | Per-architecture scale options |

### Pipeline engine & handle

| Type | Notes |
| --- | --- |
| `StreamingTtsEngine` | `createStreamingTTS()` instance: `synthesize()`, `getModelInfo()`, `getSampleRate()`, `getNumSpeakers()`, `destroy()` |
| `TtsPipelineHandle` | Extends `StreamingPipelineHandle`: `stop()`, `flush()`, `reset()`, `getStatus()`, `pipelineId`, `instanceId` |
| `TtsPipelineOptions` | `{ sid?, speed?, voiceClone? }` |
| `StreamingPipelineHandle` | Generic pipeline handle: `stop()`, `flush()`, `reset()`, `getStatus()` |
| `StreamingPipelineStatus` | `{ pipelineId, isRunning, chunksProcessed, unitsRead, unitsWritten, error }` |
| `TTSModelInfo` | `{ sampleRate, numSpeakers }` |

For incremental-only types (`IncrementalStreamingTtsEngine`, `IncrementalStreamController`, `SegmentationPolicy`, `QueuePolicy`, etc.), see [Types](#types).

## Segmentation

The streaming TTS engine can use the segmentation engine to split text before synthesis. Unlike offline TTS, streaming TTS supports all three modes because the pipeline worker can apply segment boundaries within the committed text without restarting the engine.

| Mode | Behavior |
|------|----------|
| `'off'` (default) | Each committed `LiveTextBuffer` segment is synthesized as-is |
| `'manual'` | Segmentation is driven externally; the engine pauses at explicit boundaries |
| `'auto'` | The engine uses the policy to decide where to split within committed text |

Default policy evaluator: **`text_synthetic_auto`**.

```ts
import {
  createStreamingTTS,
  createLiveTextBuffer,
  createEmptyLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
} from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({
  modelPath: { type: 'file', path: '/path/to/model' },
  modelType: 'kokoro',
});
const sampleRate = await tts.getSampleRate();
const textIn = await createLiveTextBuffer();
const audioOut = await createEmptyLiveAudioBuffer({ sampleRate, channelCount: 1 });

const pipeline = await tts.synthesize(textIn, audioOut, {
  sid: 0,
  segmentation: {
    mode: 'auto',
    // policy defaults to { evaluator: 'text_synthetic_auto' }
  },
});

await appendLiveTextSegment(textIn, 'A long paragraph that will be split automatically into sentence-sized chunks.');
await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await pipeline.stop();
await tts.destroy();
```

See [segmentation-engine.md](segmentation-engine.md) for the full segmentation reference and [memory-and-models.md](memory-and-models.md) for memory planning.

## Error codes

| Code | Meaning |
| --- | --- |
| `TTS_PIPELINE_ALREADY_RUNNING` | `synthesize()` called while a pipeline on this engine is already active |
| `TTS_PIPELINE_TEXT_BUFFER_NOT_FOUND` | Input live text buffer ID not found |
| `TTS_PIPELINE_AUDIO_BUFFER_NOT_FOUND` | Output live audio buffer ID not found |
| `TTS_PIPELINE_BUFFER_KIND_MISMATCH` | Non-live buffer passed (must be `live_*` / `txt_live_*`) |
| `TTS_PIPELINE_BUFFER_NOT_RECORDING` | Buffer already finalized; cannot start pipeline on it |
| `TTS_PIPELINE_SAMPLE_RATE_MISMATCH` | Output buffer's `sampleRate` ≠ TTS model's output sample rate |
| `TTS_PIPELINE_VOICE_CLONE_REF_NOT_FOUND` | `referenceAudioBufferId` not found in offline audio registry |
| `TTS_PIPELINE_VOICE_CLONE_UNSUPPORTED` | Voice cloning requested but model type does not support it |
| `STREAMING_PIPELINE_NOT_FOUND` | `pipelineId` not found (stop/flush/reset/status) |
| `STREAMING_PIPELINE_ERROR` | Worker thread crashed |

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `TTS_PIPELINE_ALREADY_RUNNING` | Called `synthesize()` before previous pipeline stopped | `stop()` the previous pipeline first, or create a second engine |
| `TTS_PIPELINE_SAMPLE_RATE_MISMATCH` | `LiveAudioBuffer` sample rate ≠ model sample rate | Use `tts.getSampleRate()` to get the correct rate before creating the audio buffer |
| `TTS_GENERATE_ERROR` / cloning | `voiceClone` on non–Zipvoice/Pocket model | Remove `voiceClone` or switch model |
| Zipvoice clone fails | Missing / empty `referenceText` | Use `voiceClone: { kind: 'zipvoice', referenceAudio, referenceText }` — with non-empty text; Android streaming does not support Zipvoice |
| Init throws with `modelOptions` | `modelType` is `'auto'` or omitted | Set explicit `modelType` before passing `modelOptions` |
| Methods throw after `destroy` | Engine already released | Create a new engine |
| Wrong or slow inference | Provider not built / unavailable | Check [execution-providers.md](execution-providers.md) and native logs |

## Use case examples

<details>
<summary>Basic streaming synthesis with PCM output</summary>

```ts
import {
  createStreamingTTS,
  createLiveTextBuffer,
  createEmptyLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({
  modelPath: { type: 'file', path: '/path/to/vits' },
  modelType: 'vits',
});
const sr = await tts.getSampleRate();
const textIn = await createLiveTextBuffer();
const audioOut = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });

const pipeline = await tts.synthesize(textIn, audioOut, { sid: 0, speed: 1.0 });

await appendLiveTextSegment(textIn, 'Hello, this is the first sentence.');
await appendLiveTextSegment(textIn, 'And this is the second.');
await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await finalizeLiveAudioBuffer(audioOut);
await pipeline.stop();
await tts.destroy();
```

</details>

<details>
<summary>Multi-speaker streaming synthesis with per-segment speaker override</summary>

Pass `meta.sid` per segment to override the pipeline-level speaker ID without stopping the pipeline.

```ts
import {
  createStreamingTTS,
  createLiveTextBuffer,
  createEmptyLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
} from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({ modelPath: { type: 'file', path: '/path/to/multi-speaker' }, modelType: 'vits' });
const sr = await tts.getSampleRate();
const textIn = await createLiveTextBuffer();
const audioOut = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });

const pipeline = await tts.synthesize(textIn, audioOut, { sid: 0 }); // pipeline-level default

// Override speaker per segment via meta:
await appendLiveTextSegment(textIn, 'Hello from speaker zero.', undefined, undefined, { sid: 0 });
await appendLiveTextSegment(textIn, 'Hi there from speaker one.', undefined, undefined, { sid: 1 });
await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await pipeline.stop();
await tts.destroy();
```

</details>

<details>
<summary>Streaming TTS with auto segmentation for long text feeds</summary>

Use segmentation mode `auto` to split long committed text into bounded chunks while the pipeline remains active.

```ts
import {
  createStreamingTTS,
  createLiveTextBuffer,
  createEmptyLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
} from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS({
  modelPath: { type: 'file', path: '/path/to/kokoro' },
  modelType: 'kokoro',
});

const sr = await tts.getSampleRate();
const textIn = await createLiveTextBuffer({ maxSegments: 4096 });
const audioOut = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });

const pipeline = await tts.synthesize(textIn, audioOut, {
  sid: 0,
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'text_synthetic_auto', sentenceBoundary: true, maxLengthChars: 500 },
  },
});

await appendLiveTextSegment(textIn, veryLongParagraph);
await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await pipeline.stop();
await tts.destroy();
```

</details>

## See also

- [tts-offline.md](tts-offline.md) — batch TTS, timestamps, save/share
- [pcm-player.md](pcm-player.md) — standalone PCM player
- [alignment-offline.md](alignment-offline.md) — `alignTextToAudio`, modes, alignment models (post-hoc after streaming)
- [execution-providers.md](execution-providers.md) — ORT execution providers
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)
- [README — Breaking changes](../README.md#breaking-changes-upgrading-to-100)
