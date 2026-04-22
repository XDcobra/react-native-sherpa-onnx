# Voice Activity Detection (streaming)

On-device streaming VAD with a pipeline-first API:

- **Input:** live or offline pipeline audio buffer (`audiobuffer`)
- **Output:** live or offline segment buffer (`segmentbuffer`)
- **Engine:** `createStreamingVAD` exposes `process(...)`, `addListener(...)`, `isSpeechDetected()`, and `destroy()`

Import path: `react-native-sherpa-onnx/vad`

## Models and paths

- `ModelPathConfig`: `{ type: 'asset' | 'file' | 'auto', path: string }`
- Model detection without engine init: `detectVadModel(...)`
- Supported model families: `silero_vad`, `ten_vad`

## Quick start

### 1) Streaming VAD with live segment output

```ts
import { createStreamingVAD, detectVadModel } from 'react-native-sherpa-onnx/vad';
import { createEmptyLiveAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveSegmentBuffer,
  getLiveSegmentBufferSegmentCount,
  getLiveSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

// 1) Preflight detection: verify model layout and selected VAD family.
const det = await detectVadModel(
  { kind: 'fs', path: '/absolute/path/to/vad-model-dir' },
  { modelType: 'auto' }
);
if (!det.success) throw new Error(det.error ?? 'detectVadModel failed');

// 2) Allocate pipeline buffers (live audio in, live segments out).
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const segmentOut = await createLiveSegmentBuffer({
  sourceAudioBufferId: audioIn,
  spooling: { mode: 'on' },
});

// 3) Create VAD engine (auto-detect is resolved natively before init).
const vad = await createStreamingVAD({
  modelPath: { type: 'file', path: '/absolute/path/to/vad-model-dir' },
  modelType: 'auto',
  sampleRate: 16000,
});

let printedSegments = 0;
const off = vad.addListener(async (event) => {
  if (event.type !== 'segment.appended') return;
  // Read only newly appended segments to avoid reprinting old ones.
  const total = await getLiveSegmentBufferSegmentCount(segmentOut);
  const next = total - printedSegments;
  if (next <= 0) return;
  const segs = await getLiveSegmentBufferSegments(segmentOut, printedSegments, next);
  printedSegments = total;
  for (const s of segs) {
    console.log('[vad]', s.id, `${s.startSample}-${s.endSample}`, `${s.durationMs}ms`);
  }
});

const pipeline = await vad.process({
  audioIn,
  segmentOut,
  options: { chunkSize: 512, autoFlushOnInputEnded: true },
});

// Feed mic/appended audio into `audioIn` from your audio pipeline.
// Then finalize the run:
await pipeline.flush();
await pipeline.stop();
await pipeline.completed;

off();
await vad.destroy();
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineAudioBuffer(audioIn);
```

### 2) Typical VAD + Streaming STT pipeline

```ts
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import { createEmptyLiveAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveSegmentBuffer,
  getLiveSegmentBufferSegmentCount,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

// Shared live audio stream: both VAD and STT consume the same source.
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const segmentOut = await createLiveSegmentBuffer({ sourceAudioBufferId: audioIn, spooling: { mode: 'on' } });
const textOut = await createLiveTextBuffer({ windowMaxChars: 65536, maxSegments: 2048 });

const vad = await createStreamingVAD({
  modelPath: { type: 'asset', path: 'models/vad' },
  modelType: 'auto',
  sampleRate: 16000,
});
const stt = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming-stt' },
  modelType: 'auto',
});

const vadPipeline = await vad.process({ audioIn, segmentOut, options: { chunkSize: 512 } });
const sttPipeline = await stt.transcribe(audioIn, textOut, { chunkSize: 3200 });

// In practice: append mic frames to `audioIn`.
// UI loop: combine STT partial text and current VAD segment count.
const uiTick = setInterval(async () => {
  const partial = await getLiveTextBufferPartialSlice(textOut, 0, 4096);
  const segCount = await getLiveSegmentBufferSegmentCount(segmentOut);
  const committedCount = await getLiveTextBufferSegmentCount(textOut);
  const committed =
    committedCount > 0
      ? (await getLiveTextBufferSegments(textOut, 0, committedCount))
          .map((s) => s.text)
          .join(' ')
      : '';
  console.log(`[segments=${segCount}]`, [committed, partial].filter(Boolean).join(' ').trim());
}, 200);

// Session teardown sequence.
await vadPipeline.flush();
await sttPipeline.flush();
await vadPipeline.stop();
await sttPipeline.stop();
await Promise.all([vadPipeline.completed, sttPipeline.getStatus()]);
clearInterval(uiTick);

await vad.destroy();
await stt.destroy();
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Input format | Float PCM `[-1, 1]` in a pipeline audio buffer |
| Sample rate | VAD `sampleRate` and input buffer sample rate must match model expectations (typically 16kHz) |
| Model detection | Run `detectVadModel(...)` before engine init when you want explicit preflight checks |
| Lifecycle | Stop pipeline(s), destroy engine(s), then release buffers |

## API reference

All signatures below are exported from `react-native-sherpa-onnx/vad`.

### Detection

#### `detectVadModel(source, options?)`

```ts
function detectVadModel(
  source: FileSource,
  options?: { modelType?: VADModelType | 'auto'; assetName?: string }
): Promise<VADDetectResult>;
```

```ts
const det = await detectVadModel(
  { kind: 'fs', path: '/absolute/path/to/vad-model-dir' },
  { modelType: 'auto' }
);
console.log(det.success, det.modelType, det.paths?.model);
```

### Initialization

#### `createStreamingVAD(options)`

```ts
function createStreamingVAD(options: VADInitializeOptions): Promise<VADEngine>;
```

```ts
const engine = await createStreamingVAD({
  modelPath: { type: 'asset', path: 'models/vad' },
  modelType: 'auto',
  sampleRate: 16000,
});
```

### Engine (`VADEngine`)

#### `engine.process(input)`

```ts
process(
  input: VADLiveProcessInput | VADOfflineProcessInput
): Promise<VADPipelineHandle | VADOfflineResult>;
```

```ts
const run = await engine.process({
  audioIn,
  segmentOut,
  options: { chunkSize: 512 },
});
```

#### `engine.addListener(listener)`

```ts
addListener(listener: (event: VADEvent) => void): () => void;
```

```ts
const off = engine.addListener((e) => {
  if (e.type === 'vad.stateChanged') console.log(e.isSpeechDetected);
});
off();
```

#### `engine.isSpeechDetected()`

```ts
isSpeechDetected(): Promise<boolean>;
```

```ts
const speechNow = await engine.isSpeechDetected();
```

#### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

### Pipeline handle (`VADPipelineHandle`)

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<VADPipelineStatus>;
```

## Types and constants

```ts
import {
  createStreamingVAD,
  detectVadModel,
  VAD_MODEL_TYPES,
} from 'react-native-sherpa-onnx/vad';

import type {
  VADModelType,
  VADDetectResult,
  VADInitializeOptions,
  VADEngine,
  VADEvent,
  VADPipelineHandle,
  VADPipelineStatus,
  VADSummary,
  VADOfflineResult,
} from 'react-native-sherpa-onnx/vad';
```

- `VADModelType`: `'silero_vad' | 'ten_vad'`
- `VAD_MODEL_TYPES`: readonly model type list for UI/model picker usage
- `VADDetectResult`: shared detection contract (`success`, optional `error`, `modelType`, `detectedModels`, `paths`, `languages`, `quantization`, `detectionSources`)

## Error quick table

Typical VAD-native error codes and reasons:

| Code | Typical reason |
| --- | --- |
| `VAD_BUFFER_NOT_FOUND` | Input/output buffer id is invalid or released |
| `VAD_BUFFER_KIND_MISMATCH` | Buffer kind does not match live/offline VAD path |
| `VAD_INVALID_ARGUMENT` | Invalid `instanceId`, options, or malformed inputs |
| `VAD_INVALID_STATE` | Invalid lifecycle transition (for example second live run on same instance) |
| `VAD_MODEL_INIT_FAILED` | Native model detection/init failed |
| `VAD_PIPELINE_NOT_FOUND` | Unknown or already-stopped pipeline id |
| `VAD_PIPELINE_ALREADY_RUNNING` | Engine already has an active live pipeline |
| `VAD_INTERNAL_ERROR` | Unexpected native/runtime failure |

## See also

- [Streaming STT](stt-streaming.md)
- [Offline STT](stt-offline.md)
- [Pipeline audio buffers — streaming](audiobuffer-streaming.md) · [overview](audiobuffer.md)
- [Pipeline segment buffers](segmentbuffer.md)
