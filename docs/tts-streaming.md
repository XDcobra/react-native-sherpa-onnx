# Streaming Text-to-Speech (TTS)

Pipeline-based streaming TTS: a native background worker drains text segments from a `LiveTextBuffer`, synthesizes each segment, and writes PCM samples to a `LiveAudioBuffer`. **Audio data never crosses the JS bridge during steady-state** — JS only orchestrates start/stop/status.

**For full-buffer synthesis, timestamps, and WAV save/share:** see [Offline TTS](tts-offline.md). **Streaming + subtitles:** see [Subtitles](#subtitles) and [alignment.md](alignment.md).

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

- **`ModelPathConfig`** (from `react-native-sherpa-onnx`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** below scans the model directory and returns kinds **without** initializing the engine (see [Detection](#detection)).

## Quick Start

### 1) Direct pipeline control (`synthesize`)

Use when you manage text segments and audio buffers yourself.

```ts
import {
  createStreamingTTS,
  detectTtsModel,
  createLiveTextBuffer,
  createLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/tts';

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

// Create buffers
const sampleRate = await tts.getSampleRate();
const textIn = await createLiveTextBuffer();
const audioOut = await createLiveAudioBuffer({
  sampleRate,
  channelCount: 1,
});

// Start native pipeline
const pipeline = await tts.synthesize(textIn, audioOut, {
  sid: 0,
  speed: 1.0,
});

// Push text segments (pipeline synthesizes each as it arrives)
await appendLiveTextSegment(textIn.bufferId, 'Hello world. ');
await appendLiveTextSegment(textIn.bufferId, 'How are you today?');

// Signal no more text
await finalizeLiveTextBuffer(textIn.bufferId);

// Wait for pipeline to finish processing all segments
await pipeline.flush();

// Finalize audio buffer (if downstream consumers need an end signal)
await finalizeLiveAudioBuffer(audioOut.bufferId);

// Cleanup
await pipeline.stop();
await tts.destroy();
```

### 2) Per-segment metadata overrides

Override `sid` and `speed` per segment via the `meta` parameter:

```ts
// Different speaker for each segment
await appendLiveTextSegment(textIn.bufferId, 'Hello!', undefined, undefined, { sid: 0, speed: 1.0 });
await appendLiveTextSegment(textIn.bufferId, 'Hi there!', undefined, undefined, { sid: 1, speed: 0.9 });
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

### 4) Incremental text feeding (`createIncrementalStreamingTTS`)

Use this path when text arrives progressively (chat/LLM typing). The engine handles segmentation, queue management, and pipeline lifecycle internally.

```ts
import {
  createIncrementalStreamingTTS,
  createLiveAudioBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/tts';

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

const sampleRate = await inc.getSampleRate();
const audioOut = await createLiveAudioBuffer({
  sampleRate,
  channelCount: 1,
  onFramesAppended: (info) => {
    // Track progress: info.totalFrames, info.source
  },
});

// Start a session — creates an internal LiveTextBuffer + pipeline automatically
const ctrl = await inc.startSession(audioOut, { sid: 0, speed: 1.0 });

// Push progressive text chunks (auto-segmentation detects boundaries)
ctrl.pushText('Hallo Michael. ');
ctrl.pushText('Today, the weather was amazing. But tomorrow, I think it will rain instead. ');

// commit() forces immediate enqueue even without boundary detection
ctrl.commit();

// Flush: commit remainder, finalize text buffer, wait until pipeline completes
await ctrl.flush();

// Finalize audio output
await finalizeLiveAudioBuffer(audioOut.bufferId);

// Cancel (alternative to flush — discards remaining)
// await ctrl.cancel({ scope: 'all' });

await inc.destroy();
```

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` on init; check availability via root helpers (e.g. `getCoreMlSupport`) — [execution-providers.md](execution-providers.md) |
| Subtitles + streaming | Not on the streaming API surface — finish synthesis, then **`alignTextToAudio`**; see [Subtitles](#subtitles) and [alignment.md](alignment.md) |
| Multi-instance | Each `createTTS` / `createStreamingTTS` gets a unique native `instanceId`; do not use an engine after `destroy()` |
| One pipeline per engine | `synthesize()` rejects with `TTS_PIPELINE_ALREADY_RUNNING` if a pipeline is already active on the same engine |
| Sample rate match | `audioOut.sampleRate` must equal the TTS model's output sample rate (strict — no hidden resampling) |

## API Reference

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
  lexiconLanguageCandidates?: string[];
  languages?: { iso6391Hint: string; id: string }[];
  quantization?: string;
  sizeTier?: string;
  detectionSources?: readonly DetectionSource[];
}>;
```

File-based detection and validation **without** initializing the TTS engine: no native synthesizer is created, so this call is comparatively cheap and suitable as a **pre-check** before **`createStreamingTTS`** or **`createTTS`** — for example to obtain a concrete `modelType` (and Kokoro/Kitten `lexiconLanguageCandidates`) so you can pass the right `modelOptions` on init.

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
It handles buffering, boundary detection, queue policy, and pipeline lifecycle internally.

```ts
const inc = await createIncrementalStreamingTTS({
  source: { engineOptions: { modelPath: { type: 'asset', path: 'models/my-tts-model' } } },
});
```

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

## Incremental engine (`IncrementalStreamingTtsEngine`)

### `inc.startSession(audioOut, ttsOptions?, incrementalOptions?)`

```ts
startSession(
  audioOut: LiveAudioBufferIdSource,
  ttsOptions?: TtsPipelineOptions,
  incrementalOptions?: IncrementalRequestOptions,
): Promise<IncrementalStreamController>;
```

Starts an incremental speech synthesis session:
1. Creates an internal `LiveTextBuffer` automatically.
2. Starts a TTS pipeline (`synthesize()`) from the internal text buffer to `audioOut`.
3. Returns a controller for pushing text incrementally.

Only one active session per engine instance at a time.

### `inc.getModelInfo()`, `inc.getSampleRate()`, `inc.getNumSpeakers()`, `inc.destroy()`

Same semantics as `StreamingTtsEngine`.

## Incremental stream controller (`IncrementalStreamController`)

### `ctrl.pushText(text, meta?)`

```ts
pushText(text: string, meta?: { sid?: number; speed?: number }): void;
```

Adds incremental input text. Auto-segmentation detects boundaries based on the segmentation policy and commits segments to the internal `LiveTextBuffer`. The native pipeline worker picks them up automatically.

### `ctrl.commit(options?)`

```ts
commit(options?: CommitOptions): void;
```

Force-commit the current buffer as a segment. Not required for normal operation — `pushText()` triggers auto-segmentation.

Behavior matrix:

- `pushText()` with detectable boundaries → speech generated automatically.
- `pushText()` without boundaries + timeout enabled → speech starts after timeout.
- `pushText()` without boundaries and no timeout → no generation until `commit()` or `flush()`.
- `commit()` → immediate enqueue of current buffer, bypassing boundary detection.

### `ctrl.flush(options?)`

```ts
flush(options?: FlushOptions): Promise<void>;
```

Commits remaining buffer, finalizes the internal text buffer, and resolves when all segments have been synthesized.

### `ctrl.cancel(options?)`

```ts
cancel(options?: CancelOptions): Promise<void>;
```

Cancels by scope:

- `all` (default): stops pipeline, discards active + queued, releases text buffer
- `active`: stops active synthesis only
- `queued`: discards queued segments, resets pipeline cursor; session continues

### `ctrl.getMetrics()`

```ts
getMetrics(): IncrementalMetrics;
```

Returns a snapshot: queue depth, totals, and current active segment id.

### `ctrl.pipeline`

The underlying `TtsPipelineHandle` (for `getStatus()`, etc.).

### `ctrl.textBuffer`

`{ bufferId: string }` — the internal `LiveTextBuffer` used for segmented text input.

### `ctrl.state`

Current session state: `'idle' | 'active' | 'draining' | 'cancelled' | 'errored' | 'destroyed'`.

## Pipeline options (`TtsPipelineOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sid` | `number` | `0` | Speaker ID (overridable per-segment via `meta.sid`) |
| `speed` | `number` | `1.0` | Speed multiplier (overridable per-segment via `meta.speed`) |
| `voiceClone` | `TtsVoiceClone` | — | Voice cloning config; set once for the entire pipeline |

## Types

Listed types are those used by **streaming TTS** in this document. Batch-only types (`TtsEngine`, `GeneratedAudio`, `GeneratedAudioWithTimestamps`, save helpers, `TtsUpdateOptions`, `SubtitleOptions`, …) are in [tts-offline.md](tts-offline.md). `ModelPathConfig` is imported from `react-native-sherpa-onnx`.

### Detection & model path

| Type | Notes |
| --- | --- |
| `ModelPathConfig` | `{ type: 'asset' \| 'file' \| 'auto'; path: string }` |
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
| `TTSInitializeOptions` | `createStreamingTTS()` / `IncrementalStreamingTtsSource.engineOptions` — with `modelType` omitted/`'auto'`, **`modelOptions` is disallowed** |
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

### Incremental streaming

| Type | Notes |
| --- | --- |
| `IncrementalStreamingTtsEngine` | `startSession`, `getModelInfo`, `getSampleRate`, `getNumSpeakers`, `destroy` |
| `IncrementalStreamingTtsFactoryOptions` | `{ source, segmentation?, queue? }` |
| `IncrementalStreamingTtsSource` | `{ engine: StreamingTtsEngine }` or `{ engineOptions: TTSInitializeOptions \| ModelPathConfig }` |
| `IncrementalRequestOptions` | `{ segmentation?, queue? }` |
| `IncrementalStreamHandlers` | `{ onSessionEvent?, onSegmentEvent?, onMetrics? }` |
| `IncrementalStreamController` | `pushText`, `commit`, `flush`, `cancel`, `getMetrics`, `pipeline`, `textBuffer`, `state` |
| `SegmentationPolicy` | `boundaryChars?`, `maxCharsPerSegment?`, `maxWaitMs?`, `minCharsPerSegment?`, `debounceMs?` |
| `QueuePolicy` | `mode?`, `maxSegments?`, `maxBufferedChars?`, `overflowStrategy?` |
| `QueueMode` | `'fifo' \| 'replace-tail' \| 'latest-wins'` |
| `OverflowStrategy` | `'drop-oldest' \| 'drop-newest' \| 'reject'` |
| `CommitOptions` | `{ force?: boolean }` |
| `FlushOptions` | Placeholder `{}` for `flush(options?)` |
| `CancelOptions` | `{ scope?: CancelScope }` |
| `CancelScope` | `'all' \| 'active' \| 'queued'` |
| `SessionId`, `SegmentId` | Opaque string ids on session/segment events |
| `SessionState` | `'idle' \| 'active' \| 'draining' \| 'cancelled' \| 'errored' \| 'destroyed'` |
| `IncrementalMetrics` | `{ queueDepth, totalSegmentsQueued, totalSegmentsCompleted, totalSegmentsDropped, totalSegmentsReplaced, activeSegmentId }` |
| `SessionEvent` | `session:started`, `session:idle`, `session:draining`, `session:cancelled`, `session:error` |
| `SegmentEvent` | `segment:queued`, `segment:started`, `segment:ended`, `segment:dropped` |

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

## Mapping to Native API

If you call the **`NativeSherpaOnnx`** TurboModule directly: `startTtsPipeline(instanceId, textInLiveBufferId, audioOutLiveBufferId, options?)` starts the native worker. Pipeline control methods (`stopStreamingPipeline`, `flushStreamingPipeline`, `resetStreamingPipeline`, `getStreamingPipelineStatus`) take a `pipelineId`. Prefer the factory APIs in this document unless you manage native instances yourself.

## See also

- [tts-offline.md](tts-offline.md) — batch TTS, timestamps, save/share
- [pcm-player.md](pcm-player.md) — standalone PCM player
- [alignment.md](alignment.md) — `alignTextToAudio`, modes, alignment models (post-hoc after streaming)
- [execution-providers.md](execution-providers.md) — ORT execution providers
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)
- [migration.md](migration.md) — breaking changes history
