# Streaming Text-to-Speech (TTS) - Incremental

Incremental streaming TTS is a higher-level layer over `StreamingTtsEngine`: it accepts progressively arriving text, performs boundary detection, applies queue policies, and runs the native pipeline session lifecycle for you.

**For direct pipeline control (`createStreamingTTS` + `synthesize`):** see [Streaming TTS](tts-streaming.md). **For full-buffer synthesis, timestamps, and WAV save/share:** see [Offline TTS](tts-offline.md).

**Import path:** `react-native-sherpa-onnx/tts`

## Architecture

```text
pushText() ──→ [Segmentation + Queue Policy] ──→ internal LiveTextBuffer ──→ [TTS Pipeline Worker] ──→ LiveAudioBuffer
                 (JS/session layer)                                                (native thread)
```

The incremental layer:
1. Creates/owns an internal `LiveTextBuffer` per session.
2. Splits incoming text into segments based on `SegmentationPolicy`.
3. Applies `QueuePolicy` and enqueue behavior.
4. Starts/stops the native streaming TTS pipeline automatically.
5. Exposes lifecycle and metrics via controller and events.

## Choosing a streaming API (decision matrix)

Sherpa-ONNX **offline** TTS models do **not** implement low-latency *acoustic* streaming (partial text → wavefront in real time). What this SDK calls **streaming** is **chunked PCM delivery** plus optional **segment-by-segment** synthesis: native `OfflineTts` emits audio in callbacks while a sentence (or your segment) is processed, and the pipeline writes samples into a `LiveAudioBuffer` without steady-state JS bridge traffic. **Incremental** TTS is the same engine underneath; it adds **automatic segmentation**, **queues**, and **session** semantics for *continuous* text input.

| Criterion | Prefer **`createStreamingTTS` + `synthesize()`** | Prefer **`createIncrementalStreamingTTS`** |
|-----------|---------------------------------------------------|--------------------------------------------|
| You already emit **discrete, meaningful segments** (sentences, paragraphs, UI blocks) | Yes | No |
| Text arrives as a **continuous stream** (e.g. LLM tokens, live captions) and you want the library to **cut segments** | No | Yes |
| You need **segmentation policy** (punctuation, max chars, debounce, auto-commit timeout) | Roll your own before `appendLiveTextSegment` | Built-in (`SegmentationPolicy`) |
| You need **queue behavior** (FIFO vs replace-tail vs latest-wins, overflow rules) | Roll your own | Built-in (`QueuePolicy`) |
| You need **per-segment `meta`** (`sid`, `speed`) from your own pipeline | Straightforward via `appendLiveTextSegment(..., meta)` | Use segment events / policies; cloning is pipeline-wide |
| You want the **smallest surface** (buffers + pipeline only) | Yes | No |
| You want **session lifecycle** events (idle, draining, errors) and **metrics** | Build on top | Built-in |

**Rule of thumb:** if text is **open-ended or token-sized** and you want **automatic boundaries and backpressure**, use **`createIncrementalStreamingTTS`**. If you prefer manual control over segment boundaries, use [Streaming TTS](tts-streaming.md).

## Models & paths

- **`ModelPathConfig`** (from `react-native-sherpa-onnx`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** accepts a `FileSource` and scans model files without engine initialization.

## Quick Start

### 1) Incremental text feeding (`createIncrementalStreamingTTS`)

Use this path when text arrives progressively (chat/LLM typing).

```ts
import {
  createIncrementalStreamingTTS,
  detectTtsModel,
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/tts';

const det = await detectTtsModel({ kind: 'app', base: 'files', path: 'models/vits-piper-en_US-lessac-medium' });
if (!det.success || det.modelType !== 'vits') {
  throw new Error(det.error ?? 'Expected a VITS model for this example');
}

const inc = await createIncrementalStreamingTTS({
  source: {
    engineOptions: {
      modelPath: { type: 'asset', path: 'models/vits-piper-en_US-lessac-medium' },
      modelType: det.modelType,
    },
  },
  segmentation: {
    maxCharsPerSegment: 220,
    minCharsPerSegment: 24,
    maxWaitMs: 900,
  },
});

const sampleRate = await inc.getSampleRate();
const audioOut = await createEmptyLiveAudioBuffer({
  sampleRate,
  channelCount: 1,
  onFramesAppended: (info) => {
    // info.totalFrames, info.source
  },
});

const ctrl = await inc.startSession(audioOut, { sid: 0, speed: 1.0 });
ctrl.pushText('Hallo Michael. ');
ctrl.pushText('Today, the weather was amazing. But tomorrow, I think it will rain instead. ');

// Optional: force immediate segment enqueue
ctrl.commit();

await ctrl.flush();
await finalizeLiveAudioBuffer(audioOut);
await inc.destroy();
```

### 2) Queue and cancellation behavior

```ts
const ctrl = await inc.startSession(audioOut, { sid: 0, speed: 1.0 }, {
  queue: { mode: 'replace-tail', maxSegments: 10, overflowStrategy: 'drop-oldest' },
});

ctrl.pushText('New response chunk...');

// Discard only queued segments, keep active generation running
await ctrl.cancel({ scope: 'queued' });
```

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` via `engineOptions`; check availability via root helpers — [execution-providers.md](execution-providers.md) |
| Session lifecycle | One active session per incremental engine instance |
| Sample rate match | `audioOut.sampleRate` must equal the TTS model output sample rate |
| Subtitles + streaming | Not on streaming API surface — synthesize first, then align; see [alignment.md](alignment.md) |

## API Reference

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

For TTS detections, `isStreaming` is always `true`.

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

## Factories

### `createIncrementalStreamingTTS(options)`

```ts
function createIncrementalStreamingTTS(
  options: IncrementalStreamingTtsFactoryOptions
): Promise<IncrementalStreamingTtsEngine>;
```

High-level incremental layer over `StreamingTtsEngine`. It handles buffering, boundary detection, queue policy, and pipeline lifecycle internally.

```ts
const inc = await createIncrementalStreamingTTS({
  source: { engineOptions: { modelPath: { type: 'asset', path: 'models/my-tts-model' } } },
});
```

For direct pipeline control (`createStreamingTTS(options)`), see [Streaming TTS](tts-streaming.md#factories).

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
2. Starts a TTS pipeline from the internal text buffer to `audioOut`.
3. Returns a controller for pushing text incrementally.

Only one active session per engine instance at a time.

### `inc.getModelInfo()`, `inc.getSampleRate()`, `inc.getNumSpeakers()`, `inc.destroy()`

Same semantics as `StreamingTtsEngine`.

## Incremental stream controller (`IncrementalStreamController`)

### `ctrl.pushText(text, meta?)`

```ts
pushText(text: string, meta?: { sid?: number; speed?: number }): void;
```

Adds incremental input text. Auto-segmentation detects boundaries and commits segments to the internal `LiveTextBuffer`.

### `ctrl.commit(options?)`

```ts
commit(options?: CommitOptions): void;
```

Force-commit the current buffer as a segment.

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

Underlying `TtsPipelineHandle`.

### `ctrl.textBuffer`

`{ bufferId: string }` — internal `LiveTextBuffer` used for segmented text input.

### `ctrl.state`

Current session state: `'idle' | 'active' | 'draining' | 'cancelled' | 'errored' | 'destroyed'`.

## Pipeline options (`TtsPipelineOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sid` | `number` | `0` | Speaker ID (overridable per-segment via `meta.sid`) |
| `speed` | `number` | `1.0` | Speed multiplier (overridable per-segment via `meta.speed`) |
| `voiceClone` | `TtsVoiceClone` | — | Voice cloning config; set once for the entire pipeline |

## Types

### Detection & model path

| Type | Notes |
| --- | --- |
| `ModelPathConfig` | `{ type: 'asset' | 'file' | 'auto'; path: string }` |
| `FileSource` | `{ kind: 'fs' | 'app' | 'contentUri' | 'securityScoped' | 'pad', ... }` |
| `TTSModelType` | `'vits' | 'matcha' | 'kokoro' | 'kitten' | 'pocket' | 'zipvoice' | 'supertonic' | 'auto'` |
| `TtsDetectModelResult` | Return type of `detectTtsModel()` |

### Incremental streaming

| Type | Notes |
| --- | --- |
| `IncrementalStreamingTtsEngine` | `startSession`, `getModelInfo`, `getSampleRate`, `getNumSpeakers`, `destroy` |
| `IncrementalStreamingTtsFactoryOptions` | `{ source, segmentation?, queue? }` |
| `IncrementalStreamingTtsSource` | `{ engine: StreamingTtsEngine }` or `{ engineOptions: TTSInitializeOptions | ModelPathConfig }` |
| `IncrementalRequestOptions` | `{ segmentation?, queue? }` |
| `IncrementalStreamHandlers` | `{ onSessionEvent?, onSegmentEvent?, onMetrics? }` |
| `IncrementalStreamController` | `pushText`, `commit`, `flush`, `cancel`, `getMetrics`, `pipeline`, `textBuffer`, `state` |
| `SegmentationPolicy` | `boundaryChars?`, `maxCharsPerSegment?`, `maxWaitMs?`, `minCharsPerSegment?`, `debounceMs?` |
| `QueuePolicy` | `mode?`, `maxSegments?`, `maxBufferedChars?`, `overflowStrategy?` |
| `QueueMode` | `'fifo' | 'replace-tail' | 'latest-wins'` |
| `OverflowStrategy` | `'drop-oldest' | 'drop-newest' | 'reject'` |
| `CommitOptions` | `{ force?: boolean }` |
| `FlushOptions` | Placeholder `{}` for `flush(options?)` |
| `CancelOptions` | `{ scope?: CancelScope }` |
| `CancelScope` | `'all' | 'active' | 'queued'` |
| `SessionId`, `SegmentId` | Opaque string ids on session/segment events |
| `SessionState` | `'idle' | 'active' | 'draining' | 'cancelled' | 'errored' | 'destroyed'` |
| `IncrementalMetrics` | `{ queueDepth, totalSegmentsQueued, totalSegmentsCompleted, totalSegmentsDropped, totalSegmentsReplaced, activeSegmentId }` |
| `SessionEvent` | `session:started`, `session:idle`, `session:draining`, `session:cancelled`, `session:error` |
| `SegmentEvent` | `segment:queued`, `segment:started`, `segment:ended`, `segment:dropped` |

## Error codes

Error surfaces are the same underlying streaming pipeline errors as in [Streaming TTS](tts-streaming.md#error-codes).

## Troubleshooting

For low-level pipeline issues (`TTS_PIPELINE_*`, sample-rate mismatch, provider issues), see [Streaming TTS troubleshooting](tts-streaming.md#troubleshooting).

## Mapping to Native API

Incremental streaming is implemented on top of the same native pipeline entry points (`startTtsPipeline`, `stopStreamingPipeline`, `flushStreamingPipeline`, `resetStreamingPipeline`, `getStreamingPipelineStatus`) with session-level orchestration in JS.

## See also

- [tts-streaming.md](tts-streaming.md) — direct pipeline streaming TTS
- [tts-offline.md](tts-offline.md) — batch TTS, timestamps, save/share
- [pcm-player.md](pcm-player.md) — standalone PCM player
- [alignment.md](alignment.md) — post-hoc subtitle alignment
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)
