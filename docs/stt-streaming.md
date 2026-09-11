# Streaming Speech-to-Text (STT)

## Introduction

Low-latency online recognition with a **pipeline-first** API.

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | One live PCM buffer the native worker reads |
| **Output** | [`LiveTextBuffer`](textbuffer-streaming.md) | Partial hypotheses and committed text segments |
| **Engine** | `LiveSttEngine` via `createStreamingSTT` | `transcribe(audioIn, textOut)` returns `SttPipelineHandle` for pipeline control |

Import path: `react-native-sherpa-onnx/stt`

For full-file/batch transcription, see [Offline STT](stt-offline.md).

**Naming in this doc:** **`engine`** = `LiveSttEngine`; **`pipeline`** = `SttPipelineHandle` from `engine.transcribe(...)`.

## Streaming pipeline system

`transcribe` starts a **native worker** that reads **`LiveAudioBuffer`** frames and writes partial + committed **`LiveTextBuffer`** output. Control is exclusively through the returned **`SttPipelineHandle`** (not by pushing audio through JS). For the shared meaning of **`stop` / `flush` / `reset` / `getStatus` / `completed`** and how that ties into buffer finalization, see **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**.

### Observing committed segments

Committed transcripts are **text segments** on the output `LiveTextBuffer`. Prefer **`onSegment`** on that buffer (or `subscribeLiveTextBufferEvents`) instead of polling `getLiveTextBufferSegmentCount` in a timer. See **[Pipeline text buffers — live / Committed text segments](textbuffer-streaming.md#committed-text-segments-onsegment-no-polling)**.

Live **audio** segment commits (`onSegment` on `createEmptyLiveAudioBuffer`) are a separate concern — they require **live audio segmentation** and carry **speech** metadata, not STT text. See **[Pipeline audio buffers — live / `onSegment`](audiobuffer-streaming.md#live-buffer-callbacks-onframesappended-vs-onsegment)**.

## Quick start

```ts
import {
  createStreamingSTT,
  detectSttModel,
} from 'react-native-sherpa-onnx/stt';
import {
  createEmptyLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

const source: FileSource = { kind: 'fs', path: '/path/to/my-streaming-model' };

const det = await detectSttModel(source);
if (!det.success) throw new Error(det.error ?? 'detectSttModel failed');
if (!det.isStreaming) {
  throw new Error('Detected model is not streaming-capable');
}

const engine = await createStreamingSTT({
  modelSource: { kind: 'fs', path: '/path/to/my-streaming-model' },
  modelType: 'auto',
  enableEndpoint: true,
});

const audioIn = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  channelCount: 1,
  windowSeconds: 120,
});

const textOut = await createLiveTextBuffer({
  windowMaxChars: 65536,
  maxSegments: 2048,
  onSegment: (e) => {
    console.log(`[committed ${e.segment.segmentIndex}]`, e.segment.text);
  },
});

const pipeline = await engine.transcribe(audioIn, textOut, {
  chunkSize: 3200,
});

await startMicToLiveAudioBuffer(audioIn);

// UI polling example
const tick = setInterval(async () => {
  const partial = await getLiveTextBufferPartialSlice(textOut, 0, 4096);
  const count = await getLiveTextBufferSegmentCount(textOut);
  const segments =
    count > 0
      ? await getLiveTextBufferSegments(textOut, 0, count)
      : [];

  const committed = segments.map((s) => s.text).join(' ');
  const text = [committed, partial].filter(Boolean).join(' ').trim();
  console.log(text);
}, 150);

// stop recording session
await stopMicToLiveAudioBuffer();
clearInterval(tick);

// force final decode + commit pending partial as final segment
await pipeline.flush();

const finalCount = await getLiveTextBufferSegmentCount(textOut);
const finalSegments =
  finalCount > 0
    ? await getLiveTextBufferSegments(textOut, 0, finalCount, {
        includeTokens: true,
        includeTimestamps: true,
      })
    : [];

await pipeline.stop();
await engine.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

All buffer parameters accept refs directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT` or `TEXT_INVALID_ARGUMENT`.

## Endpoint tuning

```ts
const engine = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-zipformer-en' },
  modelType: 'zipformer2_ctc',
  endpointConfig: {
    rule1: {
      mustContainNonSilence: false,
      minTrailingSilence: 1.2,
      minUtteranceLength: 0,
    },
    rule2: {
      mustContainNonSilence: true,
      minTrailingSilence: 0.8,
      minUtteranceLength: 0,
    },
    rule3: {
      mustContainNonSilence: false,
      minTrailingSilence: 0,
      minUtteranceLength: 25,
    },
  },
});
```

## Pipeline flow

| Step | Method | Result |
| --- | --- | --- |
| 1 | `createStreamingSTT(...)` | Engine (`LiveSttEngine`) allocated |
| 2 | `createEmptyLiveAudioBuffer(...)` | Live audio input buffer |
| 3 | `createLiveTextBuffer(...)` | Live text output buffer |
| 4 | `engine.transcribe(audioIn, textOut, options?)` | Native STT pipeline starts |
| 5 | `startMicToLiveAudioBuffer(...)` / append samples | Audio enters pipeline |
| 6 | `getLiveTextBufferPartialSlice(...)` + segment reads | Partial + committed text |
| 7 | `pipeline.flush()` / `pipeline.reset()` / `pipeline.stop()` | Pipeline control |
| 8 | `engine.destroy()` + release buffers | Cleanup |

## API reference

All signatures below are exported from `react-native-sherpa-onnx/stt`. Use **`detectSttModel`** from the same package for model detection before creating a streaming engine (see [Offline STT — `detectSttModel`](stt-offline.md#detectsttmodelsource-options)). For category-unknown library scans, see [model-detect.md](model-detect.md).

### `detectSttModel(source, options?)`

Shared with offline STT. Check `det.isStreaming === true` for streaming-capable packs before using `createStreamingSTT`.

```ts
function detectSttModel(
  source: FileSource,
  options?: { quantization?: QuantizationPreference; modelType?: STTModelType; assetName?: string; debug?: boolean }
): Promise<SttDetectModelResult>;
```

```ts
const det = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/streaming-zipformer-en' });
if (!det.isStreaming) throw new Error('Detected model is not streaming-capable');
```

### `createStreamingSTT(options)`

Creates a `LiveSttEngine` backed by the sherpa-onnx `OnlineRecognizer`. Each engine gets a unique `instanceId`.

```ts
function createStreamingSTT(options: StreamingSttInitOptions): Promise<LiveSttEngine>;
```

```ts
const engine = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-zipformer-en' },
  modelType: 'zipformer2_ctc',
});
```

### `createLiveSTT(options)`

Alias of `createStreamingSTT`.

```ts
function createLiveSTT(options: StreamingSttInitOptions): Promise<LiveSttEngine>;
```

### `engine.transcribe(audioIn, textOut, options?)`

Starts one native STT pipeline for this engine instance.

```ts
transcribe(
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options?: SttPipelineOptions
): Promise<SttPipelineHandle>;
```

```ts
const pipeline = await engine.transcribe(audioIn, textOut, { chunkSize: 3200 });
```

### `engine.destroy()`

Stops any active pipeline and unloads the native online engine instance.

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

### `pipeline.stop()`

**Hard teardown** of the STT worker: cancels in-flight work and removes the pipeline from the native registry. Call before releasing **`audioIn`** / **`textOut`** if the pipeline might still be running.

```ts
stop(): Promise<void>;
```

### `pipeline.flush()`

**Drain barrier:** forces decode of audio still buffered in the recognizer, runs the **tail** through the segmentation path where applicable, and commits **final** partial text to **`textOut`**. Typical order: stop feeding audio → optional **`finalizeLiveAudioBuffer(audioIn)`** → **`await pipeline.flush()`** → then **`stop()`** / **`await pipeline.completed`**.

```ts
flush(): Promise<void>;
```

### `pipeline.reset()`

Clears **online recognizer stream state** and the current **partial** text view; the pipeline **keeps running**. Use for "new session / same buffers" only when you understand the UX implications.

```ts
reset(): Promise<void>;
```

### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

### `pipeline.completed`

Resolves when the native worker has **fully stopped** (normal completion, `stop()`, or error). Prefer awaiting it **after** `flush()` / `stop()` so you do not race teardown.

```ts
readonly completed: Promise<StreamingPipelineCompletion>;
```

## Models and required files

Streaming STT uses validate category **`stt_streaming`** (keys differ from offline `stt`).

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `transducer`, `nemo_transducer` | `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt` | `encoder`, `decoder`, `joiner`, `tokens` |
| `paraformer` | `encoder*.onnx`, `decoder*.onnx`, `tokens.txt` | `encoder`, `decoder`, `tokens` |
| `zipformer2_ctc`, `nemo_ctc`, `tone_ctc` | `model*.onnx`, `tokens.txt` | `model`, `tokens` |

Query keys: `getCustomModelPathRequirements('stt_streaming', modelType)`.

- **`FileSource`** — [model-setup.md](model-setup.md)
- **Detection & init** — [model-detect.md](model-detect.md)
- Streaming types: `transducer`, `nemo_transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, `tone_ctc`
- Offline-only models (Whisper): use [Live overload](stt-offline.md#live-overload-offline-weights-live-consumption)

## Custom initialization (`initMode: 'custom'`)

Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom). Validate category: **`stt_streaming`**.

| `modelType` | Custom-init keys |
| --- | --- |
| `transducer`, `nemo_transducer` | `encoder`, `decoder`, `joiner`, `tokens` |
| `paraformer` | `encoder`, `decoder`, `tokens` |
| `zipformer2_ctc`, `nemo_ctc`, `tone_ctc` | `model`, `tokens` |

```ts
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';

const engine = await createStreamingSTT({
  initMode: 'custom',
  modelType: 'transducer',
  customConfig: {
    encoder: { kind: 'fs', path: '/path/encoder.onnx' },
    decoder: { kind: 'fs', path: '/path/decoder.onnx' },
    joiner: { kind: 'fs', path: '/path/joiner.onnx' },
    tokens: { kind: 'fs', path: '/path/tokens.txt' },
  },
  enableEndpoint: true,
});
```

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Microphone capture | `LiveAudioBuffer` (`live_*`) | Use `startMicToLiveAudioBuffer(...)` for real-time input. |
| File ingest to live path | `LiveAudioBuffer` (`live_*`) | Stream long files incrementally to avoid large one-shot decode peaks. |
| Streaming enhancement | `LiveAudioBuffer` (`live_*`) | Optional denoise stage before online STT. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Live transcript UI | `LiveTextBuffer` (`txt_live_*`) | Read partial and committed segments while pipeline runs. |
| Streaming punctuation | `LiveTextBuffer` (`txt_live_*`) | Add punctuation before downstream use. |
| Streaming TTS input | `LiveTextBuffer` (`txt_live_*`) | Feed committed text into `createTTS().synthesize(LiveText, LiveAudio, { segmentation })`. |

```mermaid
flowchart LR
  A[LiveAudioBuffer] --> B[createStreamingSTT().transcribe]
  B --> C[LiveTextBuffer]
  C --> D[UI or streaming punctuation or streaming TTS]
```

More end-to-end patterns: [feature-pipelines.md#stt-streaming-patterns](feature-pipelines.md#stt-streaming-patterns).

## Types

### Streaming-specific STT types (`react-native-sherpa-onnx/stt`)

| Type | Description |
| --- | --- |
| `OnlineSTTModelType` | `'transducer' \| 'nemo_transducer' \| 'paraformer' \| 'zipformer2_ctc' \| 'nemo_ctc' \| 'tone_ctc'` |
| `ONLINE_STT_MODEL_TYPES` | Readonly runtime list of online model types |
| `StreamingSttInitOptions` | Auto or custom init union for `createStreamingSTT` |
| `StreamingSttInitOptionsBase` | Shared fields: `enableEndpoint?`, `endpointConfig?`, `decodingMethod?`, `maxActivePaths?`, `numThreads?`, `provider?`, `debug?`, … |
| `EndpointConfig` | `{ rule1?, rule2?, rule3? }` — three endpoint rules |
| `EndpointRule` | `{ mustContainNonSilence, minTrailingSilence, minUtteranceLength }` |
| `SttPipelineOptions` | `{ chunkSize? }` — samples drained per worker loop |
| `SttPipelineHandle` | Extends `StreamingPipelineHandle` — adds `instanceId` |
| `LiveSttEngine` | `transcribe(audioIn, textOut, options?)`, `destroy` |
| `StreamingPipelineCompletion` | `{ reason: 'completed' \| 'stopped' }` from `completed` |
| `StreamingPipelineStatus` | Snapshot from `getStatus()` |

Offline engine, detect, model-options, and result types: [stt-offline.md](stt-offline.md#types).

## Error codes

| Code | Typical reason |
| --- | --- |
| `STT_STREAM_INSTANCE_NOT_FOUND` | Unknown or destroyed STT engine instance |
| `AUDIO_BUFFER_NOT_FOUND` | Input live audio buffer id is invalid |
| `TEXT_BUFFER_NOT_FOUND` | Output live text buffer id is invalid |
| `STT_INVALID_STATE` | Pipeline already running for this engine |
| `PIPELINE_NOT_FOUND` | Invalid/stopped pipeline handle id |
| `STT_INVALID_ARGUMENT` | Model/options mismatch or unsupported setup |
| `STT_INTERNAL_ERROR` | Unexpected native failure |

## See also

- [Offline STT](stt-offline.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md) · [offline](audiobuffer-offline.md)
- [Pipeline text buffers — live / streaming](textbuffer-streaming.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
