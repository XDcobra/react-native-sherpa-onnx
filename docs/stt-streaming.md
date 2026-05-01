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

## Models and paths

- `ModelPathConfig` (type from `react-native-sherpa-onnx/fileio`): `{ type: 'asset' | 'file' | 'auto', path: string }`
- Streaming-capable model types: `transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, `tone_ctc`
- If your model is offline-only (for example Whisper), use [Offline STT](stt-offline.md)
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
  modelPath: { type: 'file', path: '/path/to/my-streaming-model' },
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
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
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
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
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
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
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

`SttPipelineHandle` extends generic **`StreamingPipelineHandle`** (import from **`react-native-sherpa-onnx/audiobuffer`**). Adds **`instanceId`** for correlation with the parent engine (`LiveSttEngine`).

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

```ts
await pipeline.stop();
```

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

```ts
await pipeline.flush();
```

Forces decode of currently buffered audio and commits pending final text.

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

```ts
await pipeline.reset();
```

Resets engine stream state and clears current partial text.

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

Status fields:

- `isRunning`
- `chunksProcessed`
- `unitsRead` (audio samples)
- `unitsWritten` (text units)
- `error`

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
| Streaming TTS input | `LiveTextBuffer` (`txt_live_*`) | Feed committed text into `createStreamingTTS()`. |

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
  modelPath: { type: 'asset', path: 'models/streaming-zipformer' },
  modelType: 'zipformer2_ctc',
  enableEndpoint: true,
});
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1, windowSeconds: 120 });
const textOut = await createLiveTextBuffer({ windowMaxChars: 65536, maxSegments: 2048 });
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
const textOut = await createLiveTextBuffer({ maxSegments: 2048 });

const vad = await createStreamingVAD({ modelPath: { type: 'asset', path: 'models/vad' }, modelType: 'auto', sampleRate: 16000 });
const stt = await createStreamingSTT({ modelPath: { type: 'asset', path: 'models/streaming-stt' }, modelType: 'auto' });

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
