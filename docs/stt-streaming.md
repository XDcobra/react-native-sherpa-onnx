# Streaming Speech-to-Text (STT)

Low-latency online recognition in pipeline mode.

Import path: `react-native-sherpa-onnx/stt`

For full-file/batch transcription, see [Offline STT](stt-offline.md).

## Pipeline model

Streaming STT now runs as a native worker pipeline:

- Input: one live audio buffer (`livePcmBuffer`)
- Output: one live text buffer (`liveTextBuffer`)
- Runtime: one STT pipeline handle (`SttPipelineHandle`)

There is no per-chunk stream object in the JS API anymore.

## Models and paths

- `ModelPathConfig`: `{ type: 'asset' | 'file' | 'auto', path: string }`
- Streaming-capable model types: `transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, `tone_ctc`
- If your model is offline-only (for example Whisper), use [Offline STT](stt-offline.md)
- Model setup details: [model-setup.md](model-setup.md)

## Quick start

```ts
import {
  createStreamingSTT,
  detectSttModel,
  getOnlineTypeOrNull,
} from 'react-native-sherpa-onnx/stt';
import {
  createLiveAudioBuffer,
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

const modelPath = { type: 'asset' as const, path: 'models/my-streaming-model' };

const det = await detectSttModel(modelPath);
if (!det.success) throw new Error(det.error ?? 'detectSttModel failed');

const onlineType = getOnlineTypeOrNull(det.modelType);
if (!onlineType) {
  throw new Error('Detected model is not streaming-capable');
}

const engine = await createStreamingSTT({
  modelPath,
  modelType: onlineType,
  enableEndpoint: true,
});

const audioIn = await createLiveAudioBuffer({
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

await startMicToLiveAudioBuffer(audioIn.bufferId);

// UI polling example
const tick = setInterval(async () => {
  const partial = await getLiveTextBufferPartialSlice(textOut.bufferId, 0, 4096);
  const count = await getLiveTextBufferSegmentCount(textOut.bufferId);
  const segments =
    count > 0
      ? await getLiveTextBufferSegments(textOut.bufferId, 0, count)
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

const finalCount = await getLiveTextBufferSegmentCount(textOut.bufferId);
const finalSegments =
  finalCount > 0
    ? await getLiveTextBufferSegments(textOut.bufferId, 0, finalCount, {
        includeTokens: true,
        includeTimestamps: true,
      })
    : [];

await pipeline.stop();
await engine.destroy();
await releasePipelineTextBuffer(textOut.bufferId);
await releasePipelineAudioBuffer(audioIn.bufferId);
```

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
| 1 | `createStreamingSTT(...)` | STT engine allocated |
| 2 | `createLiveAudioBuffer(...)` | Live audio input buffer |
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
| Live microphone | [audiobuffer.md](audiobuffer.md): `startMicToLiveAudioBuffer` / `stopMicToLiveAudioBuffer` |
| Text output | [textbuffer.md](textbuffer.md): partial slice + segment log getters |
| Sample rate | Live audio buffer sample rate must match STT model sample rate |
| Lifecycle | Stop pipeline, destroy engine, and release both buffers |

## API reference

All signatures below are exported from `react-native-sherpa-onnx/stt`. Use **`detectSttModel`** from the same package for model detection before creating a streaming engine (see [Offline STT — Detection and factory](stt-offline.md#detection-and-factory)).

### Factory

#### `createStreamingSTT(options)`

```ts
function createStreamingSTT(options: StreamingSttInitOptions): Promise<LiveSttEngine>;
```

#### `createLiveSTT(options)`

Alias of `createStreamingSTT`.

```ts
function createLiveSTT(options: StreamingSttInitOptions): Promise<LiveSttEngine>;
```

### Online type helpers

Use after **`detectSttModel`** when you need a streaming-capable `modelType` or must reject offline-only models.

#### `mapDetectedToOnlineType(detectedType)`

```ts
function mapDetectedToOnlineType(detectedType: string | undefined): OnlineSTTModelType;
```

#### `getOnlineTypeOrNull(detectedType)`

```ts
function getOnlineTypeOrNull(detectedType: string | undefined): OnlineSTTModelType | null;
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

Starts one native STT pipeline for this engine instance.

#### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

Stops any active pipeline and unloads the native online recognizer instance.

### Pipeline handle (`SttPipelineHandle`)

`SttPipelineHandle` extends generic **`StreamingPipelineHandle`** (import from **`react-native-sherpa-onnx/audiobuffer`**). Adds **`instanceId`** for correlation with the parent **`LiveSttEngine`**.

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

Forces decode of currently buffered audio and commits pending final text.

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

Resets recognizer stream state and clears current partial text.

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

Status fields:

- `isRunning`
- `chunksProcessed`
- `unitsRead` (audio samples)
- `unitsWritten` (text units)
- `error`

## Streaming-relevant exports

```ts
import {
  ONLINE_STT_MODEL_TYPES,
  createStreamingSTT,
  createLiveSTT,
  mapDetectedToOnlineType,
  getOnlineTypeOrNull,
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

## Error quick table

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
- [Pipeline audio buffers (`audiobuffer`)](audiobuffer.md)
- [Pipeline text buffers (`textbuffer`)](textbuffer.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
