# Voice Activity Detection (streaming)

## Introduction

On-device streaming VAD with a pipeline-first API:

- **Input:** live or offline pipeline audio buffer (`audiobuffer`)
- **Output:** live or offline segment buffer (`segmentbuffer`)
- **Engine:** `createStreamingVAD` exposes `process(...)`, `isSpeechDetected()`, and `destroy()` (no engine-level data events)
- **Pipeline handle (live):** `onSpeechStateChanged` for speech activity; **segment buffer:** `onSegmentAppended` / `streamEvents.segmentAppended` for new segments (fat metadata; pull APIs remain)

Import path: `react-native-sherpa-onnx/vad`

## Models and paths

- `FileSource` (type from `react-native-sherpa-onnx/fileio`): `FileSource`
- Model detection without engine init: `detectVadModel(...)`
- Supported model families: `silero_vad`, `ten_vad`

## Quick start

### 1) Streaming VAD with live segment output

```ts
import { createStreamingVAD, detectVadModel } from 'react-native-sherpa-onnx/vad';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveSegmentBuffer,
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
  streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
  onSegmentAppended: (e) => {
    console.log('[vad]', e.segmentId, `${e.startSample}-${e.endSample}`, `${e.durationMs}ms`);
  },
});

// 3) Create VAD engine (auto-detect is resolved natively before init).
const vad = await createStreamingVAD({
  modelSource: { kind: 'fs', path: '/absolute/path/to/vad-model-dir' },
  modelType: det.modelType ?? 'auto',
  sampleRate: 16000,
  runtimeOptions:
    (det.modelType ?? 'silero_vad') === 'ten_vad'
      ? { tenVad: { scoreThreshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 250, windowSize: 256 } }
      : { sileroVad: { scoreThreshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 250, windowSize: 512 } },
});

const pipeline = await vad.process({
  audioIn,
  segmentOut,
  options: { chunkSize: 512, autoFlushOnInputEnded: true, speechStateEventMinIntervalMs: 0 },
});
pipeline.onSpeechStateChanged = (e) => {
  console.log('[vad speech]', e.isSpeechDetected);
};

// Feed mic/appended audio into `audioIn` from your audio pipeline.
// For a graceful/natural completion, finalize the live input buffer and wait for completion.
// Do not call pipeline.flush() after finalize; finalize already triggers terminal draining.
await finalizeLiveAudioBuffer(audioIn);
await pipeline.completed;

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
  modelSource: { kind: 'app', base: 'files', path: 'models/vad' },
  modelType: 'auto',
  sampleRate: 16000,
});
const stt = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'files', path: 'models/streaming-stt' },
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
| Lifecycle | Finalize input for graceful completion, or stop explicitly for early abort; destroy engine(s), then release buffers |

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
  modelSource: { kind: 'app', base: 'files', path: 'models/vad' },
  modelType: 'silero_vad',
  sampleRate: 16000,
  runtimeOptions: {
    sileroVad: {
      scoreThreshold: 0.5,
      minSpeechDurationMs: 250,
      minSilenceDurationMs: 250,
      maxSpeechDurationMs: 5000,
      windowSize: 512,
    },
  },
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

#### `pipeline.onSpeechStateChanged` (optional)

```ts
onSpeechStateChanged?: (event: VADSpeechStateChangedEvent) => void;
```

Assign after `process` returns to receive VAD speech/activity without polling. Throttle with `speechStateEventMinIntervalMs` in `VADLiveRunOptions`.

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

`stop()` resolves only after native worker teardown is complete. After a successful stop,
the pipeline id is terminal and may return `VAD_PIPELINE_NOT_FOUND` for later control calls.

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

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Mic or file ingest | `LiveAudioBuffer` (`live_*`) | Primary live source for streaming VAD. |
| Offline file batch source | `OfflineAudioBuffer` (`off_*`) | Used for offline VAD runs through the same engine surface. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Speech event stream | `LiveSegmentBuffer` (`seg_live_*`) | Emits speech boundaries and metadata in real time. |
| Batch segment output | `OfflineSegmentBuffer` (`seg_off_*`) | Output for post-processing/timestamp workflows. |
| Parallel streaming STT | Shared `LiveAudioBuffer` + `LiveTextBuffer` | Common dual-run setup for boundaries + transcript. |

```mermaid
flowchart LR
  A[LiveAudioBuffer] --> B[createStreamingVAD().process]
  B --> C[LiveSegmentBuffer]
  A --> D[createStreamingSTT().transcribe]
  D --> E[LiveTextBuffer]
```

More end-to-end patterns: [feature-pipelines.md#vad-streaming-patterns](feature-pipelines.md#vad-streaming-patterns).

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
  VADSpeechStateChangedEvent,
  VADPipelineHandle,
  VADPipelineStatus,
  VADSummary,
  VADOfflineResult,
} from 'react-native-sherpa-onnx/vad';
```

- `VADModelType`: `'silero_vad' | 'ten_vad'`
- `VAD_MODEL_TYPES`: readonly model type list for UI/model picker usage
- `VADDetectResult`: shared detection contract (`success`, optional `error`, `modelType`, `detectedModels`, `paths`, `languages`, `quantization`, `detectionSources`)
- `runtimeOptions`: strict model-matched options (`sileroVad` or `tenVad`) with model-score based thresholding (`scoreThreshold`)

### Runtime options by model

- `silero_vad`: `runtimeOptions.sileroVad = { scoreThreshold, minSpeechDurationMs, minSilenceDurationMs, maxSpeechDurationMs, windowSize }`
- `ten_vad`: `runtimeOptions.tenVad = { scoreThreshold, minSpeechDurationMs, minSilenceDurationMs, maxSpeechDurationMs, windowSize }`
- Session-level options stay common: `sampleRate`, `provider`, `numThreads`, `debug`
- `scoreThreshold` is the model score/probability cut-off used for speech/non-speech decisions
- `neg_threshold` is intentionally not exposed in this JS SDK contract

## Error codes

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

## Deterministic lifecycle contract

- Graceful finish path (no active ingest): `finalizeLiveAudioBuffer(audioIn)` -> `await pipeline.completed`
- Graceful finish path (active file ingest): `ingest.cancel()` -> `await ingest.done` -> `finalizeLiveAudioBuffer(audioIn)` -> `await pipeline.completed`
- Early abort path: `await pipeline.stop()`
- Do not call `pipeline.flush()` after finalize (redundant and race-prone)
- Treat `VAD_PIPELINE_NOT_FOUND` as a real terminal-state signal, not as success

## Use case examples

<details>
<summary>VAD with custom silence thresholds for noisy environments</summary>

Increase `minSilenceDurationMs` and lower `scoreThreshold` to avoid premature segment cuts in noisy audio.

```ts
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import { createEmptyLiveAudioBuffer, finalizeLiveAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { createLiveSegmentBuffer, getLiveSegmentBufferSegmentCount, releasePipelineSegmentBuffer } from 'react-native-sherpa-onnx/segmentbuffer';

const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const segmentOut = await createLiveSegmentBuffer({
  sourceAudioBufferId: audioIn,
  spooling: { mode: 'on' },
  onSegmentAppended: (e) => console.log('segment', e.segmentId, `${e.durationMs}ms`),
});

const vad = await createStreamingVAD({
  modelSource: { kind: 'fs', path: '/path/to/silero-vad' },
  modelType: 'silero_vad',
  sampleRate: 16000,
  runtimeOptions: {
    sileroVad: {
      scoreThreshold: 0.4,          // lower = more sensitive
      minSpeechDurationMs: 300,
      minSilenceDurationMs: 600,    // longer silence needed to end segment
      maxSpeechDurationMs: 10000,
      windowSize: 512,
    },
  },
});

const pipeline = await vad.process({
  audioIn,
  segmentOut,
  options: { chunkSize: 512, autoFlushOnInputEnded: true },
});
pipeline.onSpeechStateChanged = (e) => console.log('speech:', e.isSpeechDetected);

// Feed mic audio into audioIn; graceful teardown:
await finalizeLiveAudioBuffer(audioIn);
await pipeline.completed;

const count = await getLiveSegmentBufferSegmentCount(segmentOut);
console.log(`Detected ${count} speech segments`);
await vad.destroy();
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineAudioBuffer(audioIn);
```

</details>

<details>
<summary>VAD gating for downstream streaming STT (dual-pipeline)</summary>

Feed both VAD and STT pipelines the same `LiveAudioBuffer`. VAD provides segment metadata while STT produces live text from the same audio stream.

```ts
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import { createEmptyLiveAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { createLiveSegmentBuffer, releasePipelineSegmentBuffer } from 'react-native-sherpa-onnx/segmentbuffer';
import { createLiveTextBuffer, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';

const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const segmentOut = await createLiveSegmentBuffer({ sourceAudioBufferId: audioIn, spooling: { mode: 'on' } });
const textOut = await createLiveTextBuffer({ maxSegments: 2048 });

const vad = await createStreamingVAD({ modelSource: { kind: 'app', base: 'files', path: 'models/vad' }, modelType: 'auto', sampleRate: 16000 });
const stt = await createStreamingSTT({ modelSource: { kind: 'app', base: 'files', path: 'models/streaming-stt' }, modelType: 'auto' });

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

<details>
<summary>Use VAD segmentation output as anchors for alignment mode `vad`</summary>

Run VAD first to produce speech segments, then pass that segment buffer into alignment `mode: 'vad'`.

```ts
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import { createAlignment } from 'react-native-sherpa-onnx/alignment';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createEmptyOfflineSegmentBuffer,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

const vad = await createStreamingVAD({
  modelSource: { kind: 'fs', path: '/path/to/vad-model' },
  modelType: 'auto',
  sampleRate: 16000,
});

const audio = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/audio.wav' });
const vadSegments = await createEmptyOfflineSegmentBuffer({ sourceAudioBufferId: audio });
const transcript = await createOfflineTextBufferFromText('hello world from vad anchored alignment');
const alignedOut = await createEmptyOfflineSegmentBuffer({ sourceAudioBufferId: audio });

try {
  await vad.process({
    audioIn: audio,
    segmentOut: vadSegments,
    options: { chunkSize: 512 },
  });

  const alignment = createAlignment();
  await alignment.alignTextToAudio(transcript, audio, alignedOut, {
    mode: 'vad',
    granularity: 'word',
    segmentation: { source: 'vad', segmentBuffer: vadSegments },
  });
  await alignment.destroy();
} finally {
  await vad.destroy();
  await releasePipelineTextBuffer(transcript);
  await releasePipelineSegmentBuffer(vadSegments);
  await releasePipelineSegmentBuffer(alignedOut);
  await releasePipelineAudioBuffer(audio);
}
```

</details>

## See also

- [Streaming STT](stt-streaming.md)
- [Offline STT](stt-offline.md)
- [Pipeline audio buffers — streaming](audiobuffer-streaming.md) · [offline](audiobuffer-offline.md)
- [Pipeline segment buffers — live / streaming](segmentbuffer-streaming.md)
