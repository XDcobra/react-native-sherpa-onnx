# Streaming Speech-to-Text (STT)

Low-latency online recognition with partial results and endpoint detection.

- Create one streaming engine (`createStreamingSTT`)
- Create one or more streams (`engine.createStream`)
- Feed chunks (`acceptWaveform` or `processAudioChunk`)
- Read incremental text (`getResult`) and endpoint state (`isEndpoint`)

Import path: `react-native-sherpa-onnx/stt`

For full-file/batch transcription and alignment stage APIs, see [Offline STT](stt-offline.md).

## Models and paths

- `ModelPathConfig`: `{ type: 'asset' | 'file' | 'auto', path: string }`
- Streaming-capable model types: `transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, `tone_ctc`
- If your model is offline-only (for example Whisper), use [Offline STT](stt-offline.md)
- Model setup details: [model-setup.md](model-setup.md)

## Quick Start

### 1) Auto-detect model, map to online type, process chunks

```ts
import {
  createStreamingSTT,
  detectSttModel,
  getOnlineTypeOrNull,
} from 'react-native-sherpa-onnx/stt';

const modelPath = { type: 'asset' as const, path: 'models/my-stt-model' };
const det = await detectSttModel(modelPath);
if (!det.success) throw new Error(det.error ?? 'detectSttModel failed');

const onlineType = getOnlineTypeOrNull(det.modelType);
if (!onlineType) throw new Error('Detected model is not streaming-capable');

const engine = await createStreamingSTT({
  modelPath,
  modelType: onlineType,
  enableEndpoint: true,
});

const stream = await engine.createStream();
const { result, isEndpoint } = await stream.processAudioChunk(floatSamples, 16000);
console.log(result.text, result.isFinal, isEndpoint);

await stream.release();
await engine.destroy();
```

### 2) Manual decode loop (`isReady` + `decode` + `getResult`)

```ts
const engine = await createStreamingSTT({
  modelPath: { type: 'file', path: '/absolute/path/to/streaming-model' },
  modelType: 'transducer',
});

const stream = await engine.createStream();
await stream.acceptWaveform(chunk1, 16000);
await stream.acceptWaveform(chunk2, 16000);

while (await stream.isReady()) {
  await stream.decode();
  const partial = await stream.getResult();
  console.log(partial.text);
}

await stream.inputFinished();
await stream.release();
await engine.destroy();
```

### 3) Endpoint tuning

```ts
const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
  modelType: 'zipformer2_ctc',
  endpointConfig: {
    rule1: { mustContainNonSilence: false, minTrailingSilence: 1.2, minUtteranceLength: 0 },
    rule2: { mustContainNonSilence: true, minTrailingSilence: 0.8, minUtteranceLength: 0 },
    rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 25 },
  },
});
```

### 4) Multiple streams on one engine

```ts
const engine = await createStreamingSTT({
  modelPath: { type: 'file', path: '/absolute/path/to/model' },
  modelType: 'paraformer',
});

const a = await engine.createStream();
const b = await engine.createStream('optional inline hotwords');

await a.acceptWaveform(samplesA, 16000);
await b.acceptWaveform(samplesB, 16000);

await a.release();
await b.release();
await engine.destroy();
```

## Streaming flow in one table

| Step | Method | Result |
| --- | --- | --- |
| 1 | `createStreamingSTT(...)` | Engine allocated |
| 2 | `engine.createStream(...)` | New stream session |
| 3 | `stream.acceptWaveform(...)` | PCM buffered |
| 4 | `stream.isReady()` -> `stream.decode()` | Decoder advances |
| 5 | `stream.getResult()` | Partial/final text snapshot |
| 6 | `stream.isEndpoint()` | Utterance-end signal |
| 7 | `stream.reset()` or `stream.release()` | Reuse or teardown |
| 8 | `engine.destroy()` | Full cleanup |

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Input source | Feed float PCM `[-1, 1]` plus sample rate |
| Live microphone | Use [pcm-stream.md](pcm-stream.md) (`startMicToLiveAudioBuffer` + optional `emitToJs` for `processAudioChunk`) |
| Execution provider | Optional `provider`; see [execution-providers.md](execution-providers.md) |
| Lifecycle | Always `release()` streams and `destroy()` engine |

## API reference

All signatures below are exported from `react-native-sherpa-onnx/stt`.

## Factory and helpers

### `createStreamingSTT(options)`

```ts
function createStreamingSTT(options: StreamingSttInitOptions): Promise<StreamingSttEngine>;
```

```ts
const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming' },
  modelType: 'transducer',
});
```

### `mapDetectedToOnlineType(detectedType)`

```ts
function mapDetectedToOnlineType(detectedType: string | undefined): OnlineSTTModelType;
```

```ts
const onlineType = mapDetectedToOnlineType('zipformer_ctc'); // -> 'zipformer2_ctc'
```

### `getOnlineTypeOrNull(detectedType)`

```ts
function getOnlineTypeOrNull(detectedType: string | undefined): OnlineSTTModelType | null;
```

```ts
const maybeOnline = getOnlineTypeOrNull(det.modelType);
if (!maybeOnline) console.log('offline-only model');
```

## Engine API (`StreamingSttEngine`)

### `engine.createStream(hotwords?)`

```ts
createStream(hotwords?: string): Promise<SttStream>;
```

```ts
const stream = await engine.createStream('flight number AB123');
```

### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

## Stream API (`SttStream`)

### `stream.acceptWaveform(samples, sampleRate)`

```ts
acceptWaveform(samples: number[], sampleRate: number): Promise<void>;
```

```ts
await stream.acceptWaveform(chunk, 16000);
```

### `stream.inputFinished()`

```ts
inputFinished(): Promise<void>;
```

```ts
await stream.inputFinished();
```

### `stream.decode()`

```ts
decode(): Promise<void>;
```

```ts
await stream.decode();
```

### `stream.isReady()`

```ts
isReady(): Promise<boolean>;
```

```ts
if (await stream.isReady()) await stream.decode();
```

### `stream.getResult()`

```ts
getResult(): Promise<StreamingSttResult>;
```

```ts
const r = await stream.getResult();
console.log(r.text, r.isFinal);
```

### `stream.isEndpoint()`

```ts
isEndpoint(): Promise<boolean>;
```

```ts
if (await stream.isEndpoint()) console.log('end of utterance');
```

### `stream.reset()`

```ts
reset(): Promise<void>;
```

```ts
await stream.reset();
```

### `stream.release()`

```ts
release(): Promise<void>;
```

```ts
await stream.release();
```

### `stream.processAudioChunk(samples, sampleRate)`

```ts
processAudioChunk(
  samples: number[] | Float32Array,
  sampleRate: number
): Promise<{ result: StreamingSttResult; isEndpoint: boolean }>;
```

```ts
const { result, isEndpoint } = await stream.processAudioChunk(chunk, 16000);
```

## Streaming-relevant types and constants

```ts
import {
  ONLINE_STT_MODEL_TYPES,
  createStreamingSTT,
  mapDetectedToOnlineType,
  getOnlineTypeOrNull,
} from 'react-native-sherpa-onnx/stt';

import type {
  OnlineSTTModelType,
  StreamingSttInitOptions,
  StreamingSttEngine,
  SttStream,
  StreamingSttResult,
  EndpointConfig,
  EndpointRule,
} from 'react-native-sherpa-onnx/stt';
```

## Streaming error quick table

| Code | Typical reason |
| --- | --- |
| `STT_STREAM_INSTANCE_NOT_FOUND` | Unknown or destroyed streaming engine |
| `STT_STREAM_NOT_FOUND` | Invalid/released stream id |
| `STT_STREAM_DECODE_FAILED` | Native streaming operation failed |
| `STT_INVALID_ARGUMENT` | Invalid stream creation arguments (for example duplicate stream id) |
| `STT_INTERNAL_ERROR` | Unexpected native failure |

## See also

- [Offline STT](stt-offline.md)
- [Pipeline audio (`pcm-stream`)](pcm-stream.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
