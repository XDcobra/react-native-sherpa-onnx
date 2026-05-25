# Streaming Speech-to-Text (STT)

## Introduction

Low-latency online recognition in pipeline mode.

Import path: `react-native-sherpa-onnx/stt`

For full-file/batch transcription, see [Offline STT](stt-offline.md).

## Pipeline model

Streaming STT now runs as a native worker pipeline:

- Input: one live audio buffer (`livePcmBuffer`)
- Output: one live text buffer (`liveTextBuffer`)
- Runtime: one STT pipeline handle (`SttPipelineHandle`)

There is no per-chunk stream object in the JS API anymore.

**Naming in this doc:** **`engine`** is the value returned by **`createStreamingSTT`** / **`createLiveSTT`** (`LiveSttEngine`). **`pipeline`** is the handle returned by **`engine.transcribe(...)`** (`SttPipelineHandle`).

## Streaming pipeline system

`transcribe` starts a **native worker** that reads **`LiveAudioBuffer`** frames and writes partial + committed **`LiveTextBuffer`** output. Control is exclusively through the returned **`SttPipelineHandle`** (not by pushing audio through JS). For the shared meaning of **`stop` / `flush` / `reset` / `getStatus` / `completed`** and how that ties into buffer finalization, see **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**.

### Observing committed segments

Committed transcripts are **text segments** on the output `LiveTextBuffer`. Prefer **`onSegment`** on that buffer (or `subscribeLiveTextBufferEvents`) instead of polling `getLiveTextBufferSegmentCount` in a timer. See **[Pipeline text buffers — live / Committed text segments](textbuffer-streaming.md#committed-text-segments-onsegment-no-polling)**.

Live **audio** segment commits (`onSegment` on `createEmptyLiveAudioBuffer`) are a separate concern — they require **live audio segmentation** and carry **speech** metadata, not STT text. See **[Pipeline audio buffers — live / `onSegment`](audiobuffer-streaming.md#live-buffer-callbacks-onframesappended-vs-onsegment)**.

## Models and paths

- `FileSource` (type from `react-native-sherpa-onnx/fileio`): `FileSource`
- Streaming-capable model types: `transducer`, `nemo_transducer` (NeMo/Nemotron streaming transducers), `paraformer`, `zipformer2_ctc`, `nemo_ctc`, `tone_ctc`
- If your model is offline-only (for example Whisper), you can still use it for live consumption via the **[Live overload](stt-offline.md#live-overload-offline-weights-live-consumption)** pattern.
- Model setup details: [model-setup.md](model-setup.md)

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

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Input format | Float PCM `[-1, 1]` at buffer sample rate |
| Live microphone | [audiobuffer-streaming.md](audiobuffer-streaming.md): `startMicToLiveAudioBuffer` / `stopMicToLiveAudioBuffer` |
| Text output | [textbuffer-streaming.md](textbuffer-streaming.md): partial slice + segment log getters |
| Sample rate | Live audio buffer sample rate must match STT model sample rate |
| Lifecycle | Stop pipeline, destroy engine, and release both buffers |

## API reference

All signatures below are exported from `react-native-sherpa-onnx/stt`. Use **`detectSttModel`** from the same package for model detection before creating a streaming engine (see [Offline STT — Detection and factory](stt-offline.md#detection-and-factory)).

### Detection and initialization

#### `detectSttModel(source, options?)`

```ts
function detectSttModel(
  source: FileSource,
  options?: { preferInt8?: boolean; modelType?: STTModelType; assetName?: string; debug?: boolean }
): Promise<SttDetectModelResult>;
```

```ts
const det = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/streaming-zipformer-en' });
console.log(det.success, det.modelType);
```

Use this first when you need robust model-type selection before creating a streaming engine.

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

#### `createStreamingSTT(options)`

```ts
function createStreamingSTT(options: StreamingSttInitOptions): Promise<LiveSttEngine>;
```

```ts
const engine = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-zipformer-en' },
  modelType: 'zipformer2_ctc',
});
```

#### `createLiveSTT(options)`

Alias of `createStreamingSTT`.

```ts
function createLiveSTT(options: StreamingSttInitOptions): Promise<LiveSttEngine>;
```

```ts
const engine = await createLiveSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-zipformer-en' },
  modelType: 'transducer',
});
```

### Streaming model-type helpers

Use after **`detectSttModel`** when you need to check whether a model supports streaming:

```ts
const det = await detectSttModel(source);
if (!det.isStreaming) throw new Error('Detected model is not streaming-capable');
```

### Engine (`LiveSttEngine`)

#### `engine.transcribe(audioIn, textOut, options?)`

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

Starts one native STT pipeline for this engine instance.

#### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

Stops any active pipeline and unloads the native online engine instance.

### Pipeline handle (`SttPipelineHandle`)

`SttPipelineHandle` extends generic **`StreamingPipelineHandle`** (import from **`react-native-sherpa-onnx/audiobuffer`**). Adds **`instanceId`** for correlation with the parent engine (`LiveSttEngine`). The handle is the only way to **coordinate** the STT worker with **buffer lifecycle** (mic stopped, optional `finalizeLiveAudioBuffer`, then tail decode).

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

```ts
await pipeline.stop();
```

**Hard teardown** of the STT worker: cancels in-flight work and removes the pipeline from the native registry. Call before releasing **`audioIn`** / **`textOut`** if the pipeline might still be running. After a successful stop, further handle calls may fail with `PIPELINE_NOT_FOUND`.

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

```ts
await pipeline.flush();
```

**Drain barrier:** forces decode of audio still buffered in the recognizer, runs the **tail** through the segmentation path where applicable (`flushFinal`), and commits **final** partial text to **`textOut`**. Typical order: stop feeding audio (e.g. `stopMicToLiveAudioBuffer`) → optional **`finalizeLiveAudioBuffer(audioIn)`** if you need a strict end-of-stream marker → **`await pipeline.flush()`** → then **`stop()`** / **`await pipeline.completed`** as needed. See also [streaming-pipelines-overview.md](streaming-pipelines-overview.md).

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

```ts
await pipeline.reset();
```

Clears **online recognizer stream state** and the current **partial** text view; the pipeline **keeps running** if it was running. Use for “new session / same buffers” only when you understand the UX implications.

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

Fields: `isRunning`, `chunksProcessed`, `unitsRead` (audio samples), `unitsWritten` (text units), `error`.

#### `pipeline.completed`

```ts
readonly completed: Promise<StreamingPipelineCompletion>;
```

Resolves when the native worker has **fully stopped** (normal completion, `stop()`, or error). Prefer awaiting it **after** `flush()` / `stop()` so you do not race teardown. Payload includes `reason`, chunk counts, and optional `error` (see `StreamingPipelineCompletion` in `audiobuffer` types).

## Pipeline buffers (audio + text)

**Audio input**

```ts
import {
  createEmptyLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — live / streaming](audiobuffer-streaming.md) and [audiobuffer — offline](audiobuffer-offline.md).

**Text output**

```ts
import {
  createLiveTextBuffer,
  getPipelineTextBufferInfo,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
```

See [textbuffer-streaming.md](textbuffer-streaming.md).

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

## Types and constants

```ts
import {
  ONLINE_STT_MODEL_TYPES,
  createStreamingSTT,
  createLiveSTT,
} from 'react-native-sherpa-onnx/stt';

import type {
  OnlineSTTModelType,
  StreamingSttInitOptions,
  LiveSttEngine,
  SttPipelineHandle,
  SttPipelineOptions,
  EndpointConfig,
  EndpointRule,
} from 'react-native-sherpa-onnx/stt';
```

## Error codes
Typical `SttErrorCode` values from the Streaming STT layer (exact strings match native):

| Code | Typical reason |
| --- | --- |
| `STT_STREAM_INSTANCE_NOT_FOUND` | Unknown or destroyed STT engine instance |
| `AUDIO_BUFFER_NOT_FOUND` | Input live audio buffer id is invalid |
| `TEXT_BUFFER_NOT_FOUND` | Output live text buffer id is invalid |
| `STT_INVALID_STATE` | Pipeline already running for this engine |
| `PIPELINE_NOT_FOUND` | Invalid/stopped pipeline handle id |
| `STT_INVALID_ARGUMENT` | Model/options mismatch or unsupported setup |
| `STT_INTERNAL_ERROR` | Unexpected native failure |

## Use case examples

<details>
<summary>Live microphone transcription with partial text updates</summary>

```ts
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
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

const engine = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-zipformer' },
  modelType: 'zipformer2_ctc',
  enableEndpoint: true,
});
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1, windowSeconds: 120 });
const textOut = await createLiveTextBuffer({
  windowMaxChars: 65536,
  maxSegments: 2048,
  onSegment: (e) => console.log('[segment]', e.segment.text),
});
const pipeline = await engine.transcribe(audioIn, textOut, { chunkSize: 3200 });

await startMicToLiveAudioBuffer(audioIn);
const tick = setInterval(async () => {
  const partial = await getLiveTextBufferPartialSlice(textOut, 0, 4096);
  const count = await getLiveTextBufferSegmentCount(textOut);
  const committed =
    count > 0
      ? (await getLiveTextBufferSegments(textOut, 0, count)).map((s) => s.text).join(' ')
      : '';
  console.log([committed, partial].filter(Boolean).join(' ').trim());
}, 150);

await stopMicToLiveAudioBuffer();
clearInterval(tick);
await pipeline.flush();
await pipeline.stop();
await engine.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

</details>

<details>
<summary>Streaming STT with explicit VAD segmentation boundaries (dual-pipeline)</summary>

Feed both STT and VAD pipelines the same `LiveAudioBuffer`. VAD is the explicit segmentation stage and provides speech boundaries in real time while STT produces a live text output from the same stream.

```ts
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import { createEmptyLiveAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { createLiveSegmentBuffer, releasePipelineSegmentBuffer } from 'react-native-sherpa-onnx/segmentbuffer';
import { createLiveTextBuffer, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';

const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const segmentOut = await createLiveSegmentBuffer({ sourceAudioBufferId: audioIn, spooling: { mode: 'on' } });
const textOut = await createLiveTextBuffer({
  maxSegments: 2048,
  onSegment: (e) => console.log('[segment]', e.segment.text),
});

const vad = await createStreamingVAD({ modelSource: { kind: 'app', base: 'apkAsset', path: 'models/vad' }, modelType: 'auto', sampleRate: 16000 });
const stt = await createStreamingSTT({ modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-stt' }, modelType: 'auto' });

const vadPipeline = await vad.process({ audioIn, segmentOut, options: { chunkSize: 512 } });
const sttPipeline = await stt.transcribe(audioIn, textOut, { chunkSize: 3200 });

// ... feed audio into audioIn ...

await vadPipeline.flush();
await sttPipeline.flush();
await vadPipeline.stop();
await sttPipeline.stop();
await vad.destroy();
await stt.destroy();
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

</details>

## See also

- [Offline STT](stt-offline.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md) · [offline](audiobuffer-offline.md)
- [Pipeline text buffers — live / streaming](textbuffer-streaming.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

