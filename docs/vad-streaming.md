# Voice Activity Detection (streaming)

## Introduction

On-device streaming VAD with a **pipeline-first** API.

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | Pipeline audio buffer ([`audiobuffer`](audiobuffer-streaming.md)) | Live or offline PCM |
| **Output** | Segment buffer ([`segmentbuffer`](segmentbuffer-streaming.md)) | Speech segments; subscribe via `onSegmentAppended` / `streamEvents.segmentAppended` |
| **Engine** | `StreamingVadEngine` via `createStreamingVAD` | `process(...)`, `isSpeechDetected()`, `destroy()` |
| **Pipeline handle (live)** | `VADPipelineHandle` | `onSpeechStateChanged` for speech activity |

Import path: `react-native-sherpa-onnx/vad`

## Streaming pipeline system

`process` starts a **native VAD worker** that consumes **audio** and emits **speech segments** (and optional speech-state callbacks). Control uses **`VADPipelineHandle`** (`stop`, `flush`, `reset`, `getStatus`, `completed`) — same **registry-backed** pattern as STT/enhancement; see **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**. **Important:** with **`autoFlushOnInputEnded: true`** (quick start), **`finalizeLiveAudioBuffer(audioIn)`** already triggers **terminal draining** — do **not** call **`pipeline.flush()`** again afterward (redundant / race-prone). For **parallel pipelines** (VAD + STT on the same `audioIn`), call each feature’s **`flush()`** before **`stop()`** when you need a coordinated end-of-session drain.

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
const finished = await finalizeLiveAudioBuffer(audioIn);
console.log(finished.info.durationMs);
await pipeline.completed;

await vad.destroy();
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineAudioBuffer(audioIn);
```

`finalizeLiveAudioBuffer` returns **`LiveAudioBufferFinishedRef`** (`bufferId` + authoritative `info`). See [audiobuffer-streaming — info lifecycle](audiobuffer-streaming.md#info-lifecycle-live-buffers).

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
const textOut = await createLiveTextBuffer({
  windowMaxChars: 65536,
  maxSegments: 2048,
  onSegment: (e) => console.log('[stt]', e.segment.text),
});

const vad = await createStreamingVAD({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/vad' },
  modelType: 'auto',
  sampleRate: 16000,
});
const stt = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-stt' },
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
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/vad' },
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

Offline batch: `segmentation` and `onProgress` on `options` are documented under **[Segmentation](#segmentation)** (offline `off_*` audio only).

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

The handle wires **speech-state callbacks** and the same **control verbs** as other streaming pipelines. **`getStatus`** returns **`VADPipelineStatus`** (VAD-specific fields in addition to the usual running / counters pattern). See **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)** for how **`flush` / `stop` / `completed`** interact with **buffer finalize** vs **parallel STT**.

#### `pipeline.onSpeechStateChanged` (optional)

```ts
onSpeechStateChanged?: (event: VADSpeechStateChangedEvent) => void;
```

Assign after `process` returns to receive VAD speech/activity without polling. Throttle with `speechStateEventMinIntervalMs` in `VADLiveRunOptions`.

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

**Hard teardown** of the VAD worker. Resolves after native teardown; the pipeline id is then **terminal** (later control calls may return `VAD_PIPELINE_NOT_FOUND`).

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

**Drain barrier:** forces the worker to **process pending audio** and flush internal state into **`segmentOut`** where applicable. Use when **`autoFlushOnInputEnded`** is **false** or when coordinating **multiple** pipelines on the same audio (flush VAD and STT before stops). **Do not** call after **`finalizeLiveAudioBuffer`** when **`autoFlushOnInputEnded: true`** — finalize already ran terminal draining (see quick start comment).

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

Clears **VAD runtime state** (e.g. hangover counters) while keeping the pipeline registered; semantics follow native `resetStreamingPipeline` for this worker.

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<VADPipelineStatus>;
```

Snapshot of worker progress and VAD-specific flags (see exported `VADPipelineStatus` type).

#### `pipeline.completed`

Resolves when the worker has **fully stopped** (normal completion after finalize + auto-flush, `stop()`, or error). Use with **`await finalizeLiveAudioBuffer`** in the graceful path shown in the quick start.

## Models and paths

- **`FileSource`** — [model-setup.md](model-setup.md)
- **Detection & init** — [model-detect.md](model-detect.md)
- Families: `silero_vad`, `ten_vad`

## Validation required files

| `modelType` | Required files | Optional | Custom-init keys |
| --- | --- | --- | --- |
| `silero_vad` | `*.onnx` (silero VAD) | — | `model` |
| `ten_vad` | `*.onnx` (ten VAD) | — | `model` |

## Model detection

`detectVadModel` validates Silero / Ten layouts before `createStreamingVAD`. Unified catalog: [model-detect.md](model-detect.md).

## Custom initialization (`initMode: 'custom'`)

Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom).

| `modelType` | Custom-init keys |
| --- | --- |
| `silero_vad`, `ten_vad` | `model` |

```ts
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';

const vad = await createStreamingVAD({
  initMode: 'custom',
  modelType: 'silero_vad',
  customConfig: {
    model: { kind: 'fs', path: '/data/models/silero_vad.onnx' },
  },
  sampleRate: 16000,
  runtimeOptions: {
    sileroVad: { scoreThreshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 250 },
  },
});
```

`runtimeOptions` work the same as auto mode.

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

## Segmentation

**Scope:** `options.segmentation` and `onProgress` exist only on **`VADOfflineRunOptions`**. The live `process` overload uses **`VADLiveProcessInput`** / **`VADLiveRunOptions`** — no batch segmentation step; use segment-buffer events instead.

| | Offline batch (`off_*` → `seg_off_*` or `live_*` out) | Streaming pipeline (`live_*` → `live_*`) |
| --- | --- | --- |
| **Input audio** | `OfflineAudioBuffer` — full file (or finalized chunk) in one buffer | `LiveAudioBuffer` — samples appended over time |
| **Segmentation engine** | Optional: `segmentation.mode: 'auto'` splits **offline** PCM into **speech** slices before VAD | **Not used** — the native VAD worker consumes the live stream directly |
| **Progress** | `onProgress` with `OrchestrationProgress` **only** when `mode: 'auto'` and at least one speech slice exists; **`mode: 'off'`** → single native pass, **no** `onProgress` (STT single-pass parity) | **No** `OrchestrationProgress`. Use **`onSegmentAppended`** / `streamEvents.segmentAppended` on the **live** segment buffer for incremental segments |
| **Stop / teardown** | Run to completion (no mid-batch cancel on offline options) | Use **`pipeline.stop()`** / teardown |

> `'manual'` segmentation mode is **not** supported for offline VAD (`supportsManual: false` in validation).

### Modes (offline only)

- **`'off'`** (default) — one `runVadOffline` over the **entire** `off_*` buffer; smallest surprise vs. pre-segmentation behavior.
- **`'auto'`** — `segmentOfflineBuffer` + `getSegments` (domain **speech**); one `runVadOffline` per slice; results merged into `segmentOut`. **Segment boundaries can differ** from single-pass `off`; keep `'off'` if you need single-pass whole-file boundaries.

For `mode: 'auto'`, **`policy` is required** (validation). The snippet below uses the same default shape as `validateSegmentationConfig` for offline VAD (`speech_energy_silence`, …). Tune in [segmentation-engine.md](segmentation-engine.md).

### Offline: default (no segmentation)

```ts
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

const vad = await createStreamingVAD({
  modelSource: { kind: 'fs', path: '/path/to/vad-model' },
  modelType: 'auto',
  sampleRate: 16000,
});

const audio = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});
const segOut = await createEmptyOfflineSegmentBuffer({ sourceAudioBufferId: audio });

const { summary, segmentBufferId } = await vad.process({
  audioIn: audio,
  segmentOut: segOut,
  // segmentation omitted → same as mode: 'off'
});

console.log(summary.segmentCount, segmentBufferId);

await vad.destroy();
await releasePipelineSegmentBuffer(segOut);
await releasePipelineAudioBuffer(audio);
```

### Offline: segmented + progress

`segmentation.mode: 'auto'` requires a **`policy`** object. `onProgress` fires **before** each per-slice `runVadOffline` (same field meanings as `offlineOrchestrator` / STT batch).

```ts
const controller = new AbortController();
const { summary } = await vad.process({
  audioIn: audio,
  segmentOut: segOut,
  options: {
    segmentation: {
      mode: 'auto',
      policy: {
        evaluator: 'speech_energy_silence',
        silenceThresholdMs: 500,
        energyThresholdDb: -40,
        minSegmentMs: 1000,
        maxSegmentMs: 120_000,
        hangoverMs: 300,
      },
    },
    onProgress: (p) =>
      console.log(`vad slice ${p.currentSegment + 1}/${p.totalSegments}`, p.fraction),
  },
});
```

**Edge cases (`auto`):** zero speech slices → zero summary, **no** native calls, **no** `onProgress`. `onProgress` throws → run aborts. Fail-fast per segment (no STT-style retries on `VADOfflineRunOptions`).

### Streaming: live buffers (no `segmentation` options)

Use **`VADLiveProcessInput`**: `live_*` audio in, `live_*` segment buffer out. Segment growth is **event-driven**, not `OrchestrationProgress`.

```ts
const pipeline = await vad.process({
  audioIn: liveAudio,
  segmentOut: liveSeg,
  options: {
    chunkSize: 512,
    autoFlushOnInputEnded: true,
    // no segmentation / onProgress here — use onSegmentAppended on liveSeg
  },
});
```

See **Quick start** above for a full `onSegmentAppended` example.


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
const finished = await finalizeLiveAudioBuffer(audioIn);
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
const textOut = await createLiveTextBuffer({
  maxSegments: 2048,
  onSegment: (e) => console.log('[stt]', e.segment.text),
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

- [Segmentation engine](segmentation-engine.md)
- [Streaming STT](stt-streaming.md)
- [Offline STT](stt-offline.md)
- [Pipeline audio buffers — streaming](audiobuffer-streaming.md) · [offline](audiobuffer-offline.md)
- [Pipeline segment buffers — live / streaming](segmentbuffer-streaming.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

