# Offline Speech-to-Text (STT)

On-device batch transcription with a pipeline-first API:

- Transcribe from file, float PCM, or native audio buffer
- Receive a lightweight `SttTranscribeRef` first
- Fetch heavy fields lazily via getters (text/tokens/timestamps/durations)
- Optional alignment stage (JSON/SRT/VTT export)

Import path: `react-native-sherpa-onnx/stt`

For live/real-time recognition, see [Streaming STT](stt-streaming.md).

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

### 1) Detect, create engine, transcribe file

```ts
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';

const modelPath = { type: 'asset' as const, path: 'models/sherpa-onnx-whisper-tiny-en' };

const det = await detectSttModel(modelPath);
if (!det.success) throw new Error(det.error ?? 'STT detection failed');

const stt = await createSTT({
  modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  preferInt8: true,
  numThreads: 2,
});

const ref = await stt.transcribeFile('/absolute/path/audio.wav');
const text = await stt.getSttResultText(ref.resultId!);
console.log(text);

await stt.destroy();
```

### 2) Buffer-first pipeline (`createOfflineAudioBufferFromFile` + `transcribeFromAudioBuffer`)

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

const { bufferId } = await createOfflineAudioBufferFromFile('/absolute/path/input.wav', 16000, true);
const ref = await stt.transcribeFromAudioBuffer(bufferId, {
  sourceTag: 'episode-42-intro',
});

const tokens = await stt.getSttResultTokens(ref.resultId!, 0, 64);
console.log(tokens.slice(0, 8));

await releasePipelineAudioBuffer(bufferId);
await stt.destroy();
```

### 3) Alignment stage from STT result

```ts
import {
  createSTT,
  alignSttResult,
  getAlignmentSegments,
  saveAlignment,
  releaseAlignment,
} from 'react-native-sherpa-onnx/stt';
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';

const stt = await createSTT({ /* ...model options... */ });
const { bufferId } = await createOfflineAudioBufferFromFile('/absolute/path/input.wav', 16000, true);

// The audio buffer and the STT instance must use the same sample rate.
// Transcribing from the same buffer guarantees this automatically.
const ref = await stt.transcribeFromAudioBuffer(bufferId);

const aligned = await alignSttResult(stt.instanceId, ref.resultId!, bufferId, {
  granularity: 'word',
  // alignmentModelId optional; omit for proportional mode
});

const segments = await getAlignmentSegments(aligned.alignmentId!, 0, 32);
console.log(segments[0]);

await saveAlignment(aligned.alignmentId!, '/absolute/path/out.srt', 'srt');
await releaseAlignment(aligned.alignmentId!);
```

### 4) Align arbitrary text to an audio buffer

```ts
import {
  alignTextToBuffer,
  getAlignmentSegments,
} from 'react-native-sherpa-onnx/stt';
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';

const { bufferId } = await createOfflineAudioBufferFromFile('/absolute/path/chunk.wav');

const ref = await alignTextToBuffer('Hello world from VoiceLab', bufferId, {
  granularity: 'segment',
});

const segs = await getAlignmentSegments(ref.alignmentId!);
console.log(segs);
```

## Data model and lifetime

| Item | Behavior |
| --- | --- |
| STT result retention | Per engine instance, only one retained result slot is active |
| New transcription | Replaces the previous retained result |
| Old `resultId` | Becomes stale (`STT_STALE_RESULT`) |
| Array/text payloads | Loaded lazily through getter methods |
| Buffer registry | Shared native buffer store by `bufferId` |
| Alignment store | Shared native alignment store by `alignmentId` |

Slice defaults and limits:

| Area | Default `maxCount` | Max `maxCount` |
| --- | --- | --- |
| STT getters (`tokens`/`timestamps`/`durations`) | `1024` | `16384` |
| Alignment segments | `512` | `8192` |

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional `provider` on init; details: [execution-providers.md](execution-providers.md) |
| Accurate alignment | Provide `alignmentModelId` in `alignSttResult`/`alignTextToBuffer`; see [alignment.md](alignment.md) |
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

### `stt.transcribeFile(filePath)`

```ts
transcribeFile(filePath: string): Promise<SttTranscribeRef>;
```

```ts
const ref = await stt.transcribeFile('/absolute/path/a.wav');
```

### `stt.transcribeSamples(samples, sampleRate)`

```ts
transcribeSamples(samples: number[], sampleRate: number): Promise<SttTranscribeRef>;
```

```ts
const ref = await stt.transcribeSamples(floatSamples, 16000);
```

### `stt.transcribeFromAudioBuffer(bufferId, options?)`

```ts
transcribeFromAudioBuffer(bufferId: string, options?: { sourceTag?: string }): Promise<SttTranscribeRef>;
```

```ts
const ref = await stt.transcribeFromAudioBuffer(bufferId, { sourceTag: 'preprocessed' });
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

`transcribeFromAudioBuffer` and alignment methods accept `off_…` buffer IDs from this module.

## Alignment stage API

### `alignSttResult(instanceId, resultId, bufferId, options?)`

```ts
function alignSttResult(
  instanceId: string,
  resultId: number,
  bufferId: string,
  options?: { alignmentModelId?: string; granularity?: 'segment' | 'word' | 'token' }
): Promise<AlignmentRef>;
```

```ts
const aligned = await alignSttResult(stt.instanceId, ref.resultId!, bufferId, { granularity: 'word' });
```

### `alignTextToBuffer(text, bufferId, options?)`

```ts
function alignTextToBuffer(
  text: string,
  bufferId: string,
  options?: { alignmentModelId?: string; granularity?: 'segment' | 'word' | 'token' }
): Promise<AlignmentRef>;
```

```ts
const aligned = await alignTextToBuffer('Hello from alignment', bufferId, { granularity: 'segment' });
```

### `getAlignmentSegments(alignmentId, start?, maxCount?)`

```ts
function getAlignmentSegments(
  alignmentId: number,
  start?: number,
  maxCount?: number
): Promise<AlignmentSegment[]>;
```

```ts
const segs = await getAlignmentSegments(aligned.alignmentId!, 0, 64);
```

### `saveAlignment(alignmentId, targetPath, format?)`

```ts
function saveAlignment(
  alignmentId: number,
  targetPath: string,
  format?: 'json' | 'srt' | 'vtt'
): Promise<void>;
```

```ts
await saveAlignment(aligned.alignmentId!, '/absolute/path/alignment.vtt', 'vtt');
```

### `releaseAlignment(alignmentId)`

```ts
function releaseAlignment(alignmentId: number): Promise<void>;
```

```ts
await releaseAlignment(aligned.alignmentId!);
```

## Offline-relevant types and constants

```ts
import {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  SttErrorCode,
  STT_DEFAULT_SLICE_COUNT,
  STT_MAX_SLICE_COUNT,
  ALIGNMENT_DEFAULT_SLICE_COUNT,
  ALIGNMENT_MAX_SLICE_COUNT,
} from 'react-native-sherpa-onnx/stt';

import type {
  STTModelType,
  STTInitializeOptions,
  SttEngine,
  SttTranscribeRef,
  SttRuntimeConfig,
  SttModelOptions,
  AudioBufferInfo,
  AlignmentRef,
  AlignmentSegment,
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
| `STT_ALIGNMENT_INPUT_MISMATCH` | STT result sample rate and buffer sample rate differ |
| `STT_ALIGNMENT_NOT_FOUND` | Unknown `alignmentId` |

## See also

- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers (`audiobuffer`)](audiobuffer.md)
- [Hotwords](hotwords.md)
- [Alignment](alignment.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
