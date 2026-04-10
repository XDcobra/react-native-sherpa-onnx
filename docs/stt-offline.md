# Offline Speech-to-Text (STT)

On-device batch transcription with a pipeline-first API:

- Transcribe from a pipeline audio buffer (`bufferId`)
- Receive a lightweight `SttTranscribeRef` first
- Fetch heavy fields lazily via getters (text/tokens/timestamps/durations)

Import path: `react-native-sherpa-onnx/stt`

For live/real-time recognition, see [Streaming STT](stt-streaming.md).
For alignment (JSON/SRT/VTT export), see [Alignment](alignment.md).

## Models and paths

- `ModelPathConfig`: `{ type: 'asset' | 'file' | 'auto', path: string }`
- In-app model downloads: [download-manager.md](download-manager.md) with category `ModelCategory.Stt`
- Model detection without engine init: `detectSttModel(...)`
- Model setup and expected files: [model-setup.md](model-setup.md)
- Hotwords details: [hotwords.md](hotwords.md)

## Validation required files

`detectSttModel(...)` and `createSTT(...)` both validate required files per detected model type.

| Model type | Typical required files |
| --- | --- |
| `transducer`, `nemo_transducer` | `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt` |
| `paraformer` | `model*.onnx` or paraformer model file, plus `tokens.txt` |
| `zipformer_ctc`, `ctc`, `nemo_ctc`, `wenet_ctc`, `sense_voice`, `telespeech_ctc` | `model*.onnx`, `tokens.txt` |
| `whisper` | `encoder*.onnx`, `decoder*.onnx`, `tokens.txt` |
| `qwen3_asr` | qwen3 frontend/encoder/decoder/tokenizer files |
| `cohere_transcribe` | cohere encoder/decoder files, plus `tokens.txt` |
| `fire_red_asr`, `canary` | encoder and decoder files |
| `moonshine`, `dolphin`, `omnilingual`, `medasr`, `funasr_nano` | model-family specific required files |

If validation fails, `success` is `false` and `error` contains the missing-file reason.

## Quick Start

### 1) Detect, create engine, transcribe from buffer

```ts
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const modelPath = { type: 'asset' as const, path: 'models/sherpa-onnx-whisper-tiny-en' };

const det = await detectSttModel(modelPath);
if (!det.success) throw new Error(det.error ?? 'STT detection failed');

const stt = await createSTT({
  modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  preferInt8: true,
  numThreads: 2,
});

const offline = await createOfflineAudioBufferFromFile('/absolute/path/audio.wav');
try {
  const ref = await stt.transcribe(offline);
  const text = await stt.getSttResultText(ref.resultId!);
  console.log(text);
} finally {
  await releasePipelineAudioBuffer(offline.bufferId);
}

await stt.destroy();
```

### 2) Transcribe and read tokens

```ts
import { createSTT } from 'react-native-sherpa-onnx/stt';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const stt = await createSTT({
  modelPath: { type: 'file', path: '/absolute/path/to/model' },
  modelType: 'auto',
});

const offline = await createOfflineAudioBufferFromFile('/absolute/path/input.wav');
try {
  const ref = await stt.transcribe(offline);
  const tokens = await stt.getSttResultTokens(ref.resultId!, 0, 64);
  console.log(tokens.slice(0, 8));
} finally {
  await releasePipelineAudioBuffer(offline.bufferId);
}

await stt.destroy();
```

## Data model and lifetime

| Item | Behavior |
| --- | --- |
| STT result retention | Per engine instance, only one retained result slot is active |
| New transcription | Replaces the previous retained result |
| Old `resultId` | Becomes stale (`STT_STALE_RESULT`) |
| Array/text payloads | Loaded lazily through getter methods |
| Buffer registry | Shared native buffer store by `bufferId` |

Slice defaults and limits:

| Area | Default `maxCount` | Max `maxCount` |
| --- | --- | --- |
| STT getters (`tokens`/`timestamps`/`durations`) | `1024` | `16384` |

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional `provider` on init; details: [execution-providers.md](execution-providers.md) |
| Audio preprocessing | Use [audio-conversion.md](audio-conversion.md) when source is not suitable PCM/WAV |
| Instance lifetime | Always call `destroy()` when done |

## API reference

All signatures below are exported from `react-native-sherpa-onnx/stt`.

## Detection and factory

### `detectSttModel(modelPath, options?)`

```ts
function detectSttModel(
  modelPath: ModelPathConfig,
  options?: { preferInt8?: boolean; modelType?: STTModelType; assetName?: string; debug?: boolean }
): Promise<SttDetectModelResult>;
```

```ts
const det = await detectSttModel({ type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' });
console.log(det.success, det.modelType, det.detectedModels);
```

### `createSTT(options)`

```ts
function createSTT(options: STTInitializeOptions | ModelPathConfig): Promise<SttEngine>;
```

```ts
const stt = await createSTT({
  modelPath: { type: 'file', path: '/absolute/path/model' },
  modelType: 'auto',
});
```

## Engine methods (`SttEngine`)

### `stt.transcribe(buffer)`

```ts
transcribe(
  buffer: OfflineAudioBufferRef | OfflineBufferHandle | string
): Promise<SttTranscribeRef>;
```

```ts
const ref = await stt.transcribe(bufferId);
const ref2 = await stt.transcribe(offlineRef);
```

### `stt.getSttResultText(resultId)`

```ts
getSttResultText(resultId: number): Promise<string>;
```

```ts
const text = await stt.getSttResultText(ref.resultId!);
```

### `stt.getSttResultTokens(resultId, start?, maxCount?)`

```ts
getSttResultTokens(resultId: number, start?: number, maxCount?: number): Promise<string[]>;
```

```ts
const tokens = await stt.getSttResultTokens(ref.resultId!, 0, 128);
```

### `stt.getSttResultTimestamps(resultId, start?, maxCount?)`

```ts
getSttResultTimestamps(resultId: number, start?: number, maxCount?: number): Promise<number[]>;
```

```ts
const times = await stt.getSttResultTimestamps(ref.resultId!, 0, 128);
```

### `stt.getSttResultDurations(resultId, start?, maxCount?)`

```ts
getSttResultDurations(resultId: number, start?: number, maxCount?: number): Promise<number[]>;
```

```ts
const durs = await stt.getSttResultDurations(ref.resultId!, 0, 128);
```

### `stt.getSttResultLang(resultId)`

```ts
getSttResultLang(resultId: number): Promise<string>;
```

```ts
const lang = await stt.getSttResultLang(ref.resultId!);
```

### `stt.getSttResultEmotion(resultId)`

```ts
getSttResultEmotion(resultId: number): Promise<string>;
```

```ts
const emotion = await stt.getSttResultEmotion(ref.resultId!);
```

### `stt.getSttResultEvent(resultId)`

```ts
getSttResultEvent(resultId: number): Promise<string>;
```

```ts
const event = await stt.getSttResultEvent(ref.resultId!);
```

### `stt.releaseSttResult()`

```ts
releaseSttResult(): Promise<void>;
```

```ts
await stt.releaseSttResult();
```

### `stt.setConfig(options)`

```ts
setConfig(options: SttRuntimeConfig): Promise<void>;
```

```ts
await stt.setConfig({ decodingMethod: 'modified_beam_search', maxActivePaths: 8 });
```

### `stt.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await stt.destroy();
```

## Audio buffer API

Audio buffers are managed through the [audiobuffer](audiobuffer.md) module:

```ts
import {
  createOfflineAudioBufferFromFile,
  createOfflineAudioBufferFromSamples,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

`transcribe` accepts `off_…` buffer IDs from this module.

## Offline-relevant types and constants

```ts
import {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  SttErrorCode,
  STT_DEFAULT_SLICE_COUNT,
  STT_MAX_SLICE_COUNT,
} from 'react-native-sherpa-onnx/stt';

import type {
  STTModelType,
  STTInitializeOptions,
  SttEngine,
  SttTranscribeRef,
  SttRuntimeConfig,
  SttModelOptions,
  AudioBufferInfo,
  SttErrorCodeValue,
} from 'react-native-sherpa-onnx/stt';
```

## Error code quick table

| Code | Typical reason |
| --- | --- |
| `STT_INSTANCE_NOT_FOUND` | Unknown/destroyed engine |
| `STT_NOT_INITIALIZED` | Transcribe called before init completed |
| `STT_BUFFER_NOT_FOUND` | Invalid `bufferId` |
| `STT_RESULT_EMPTY` | No retained result in current instance |
| `STT_STALE_RESULT` | Requested `resultId` was superseded |
| `STT_SLICE_INVALID` | `start < 0` or `maxCount <= 0` |
| `STT_SLICE_TOO_LARGE` | `maxCount` exceeds max slice |

## See also

- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers (`audiobuffer`)](audiobuffer.md)
- [Alignment](alignment.md)
- [Hotwords](hotwords.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
