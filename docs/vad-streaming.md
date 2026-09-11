# Voice Activity Detection (streaming)

## Introduction

On-device streaming VAD with a **pipeline-first** API. Detects speech boundaries in live or offline audio and emits speech segments to a segment buffer.

Import path: **`react-native-sherpa-onnx/vad`**.

## Streaming pipeline system

`process` starts a **native VAD worker** that consumes **audio** and emits **speech segments** (and optional speech-state callbacks). Control uses **`VADPipelineHandle`** (`stop`, `flush`, `reset`, `getStatus`, `completed`) — same **registry-backed** pattern as STT/enhancement; see **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**. **Important:** with **`autoFlushOnInputEnded: true`** (quick start), **`finalizeLiveAudioBuffer(audioIn)`** already triggers **terminal draining** — do **not** call **`pipeline.flush()`** again afterward (redundant / race-prone). For **parallel pipelines** (VAD + STT on the same `audioIn`), call each feature's **`flush()`** before **`stop()`** when you need a coordinated end-of-session drain.

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

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`LiveAudioBuffer`](audiobuffer-streaming.md) or [`OfflineAudioBuffer`](audiobuffer-offline.md) | Live PCM or offline file |
| **Segments out** | [`LiveSegmentBuffer`](segmentbuffer-streaming.md) or [`OfflineSegmentBuffer`](segmentbuffer-offline.md) | Match live vs offline audio; live: subscribe via `onSegmentAppended` |
| **Return** | `VADPipelineHandle` / `VADOfflineResult` | Live pipeline handle vs offline batch result |
| **Engine** | `VADEngine` via `createStreamingVAD` | `process(...)`, `isSpeechDetected()`, `destroy()` |
| **Pipeline handle (live)** | `VADPipelineHandle` | `onSpeechStateChanged`, `stop` / `flush` / `reset` / `getStatus` / `completed` |

## Segmentation (Optional)

Offline VAD can optionally split the input audio before running detection on each slice. The live `process` path does **not** use `options.segmentation` — use `onSegmentAppended` on the live segment buffer instead.

**Modes (offline):** `'off'` (default — single `runVadOffline` over the whole buffer) | `'auto'` (policy-driven slices; `policy` required). `'manual'` is not supported.

| Evaluator | Supported | Notes |
| --- | --- | --- |
| `speech_energy_silence` | ✅ **Default** | Silence/low-energy boundaries; natural speech split points |
| `continuous_frames` | ✅ | Fixed-interval checkpoints; `checkpointIntervalMs` |
| Text evaluators | ❌ | Audio-domain input only |

| | Offline batch | Live pipeline |
| --- | --- | --- |
| **Segmentation** | `options.segmentation` + `onProgress` | Not used — native VAD consumes live stream directly |
| **Progress** | `OrchestrationProgress` per slice (`auto` only) | `onSegmentAppended` on `LiveSegmentBuffer` |
| **Cancel** | Runs to completion | `pipeline.stop()` |

```ts
const { summary } = await vad.process({
  audioIn: audio,
  segmentOut: segOut,
  options: {
    segmentation: {
      mode: 'auto',
      policy: { evaluator: 'speech_energy_silence', maxSegmentMs: 120_000 },
    },
    onProgress: (p) => console.log(`slice ${p.currentSegment + 1}/${p.totalSegments}`),
  },
});
```

Full policy reference: [segmentation-engine.md](segmentation-engine.md). Memory planning: [memory-and-models.md](memory-and-models.md).

## Models

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `silero_vad` | `*.onnx` (silero VAD) | `model` |
| `ten_vad` | `*.onnx` (ten VAD) | `model` |

Validate category: **`vad`**. Overview: [README — VAD](../README.md#supported-model-types) · detection: [model-detect.md](model-detect.md) · downloads: [download-manager.md](download-manager.md) (`ModelCategory.Vad`).

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

## API reference

All signatures below are exported from `react-native-sherpa-onnx/vad`.

### `detectVadModel(source, options?)`

File-based detection **without** initializing the engine. Use before `createStreamingVAD` to confirm pack layout and model family. Unified cross-feature detection: [model-detect.md](model-detect.md).

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

### `createStreamingVAD(options)`

Creates a `VADEngine`. Init modes: **`auto`** (default — `modelSource` + optional `modelType` / `quantization`) or **`custom`** (`initMode: 'custom'` + `modelType` + `customConfig: { model }`). Shared tuning: `sampleRate`, `runtimeOptions`, `numThreads`, `provider`, `debug`.

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

### `engine.process(input)` — live

Starts a native VAD worker on a `LiveAudioBuffer` → `LiveSegmentBuffer` pair. Returns a `VADPipelineHandle` for control and speech-state callbacks.

```ts
process(
  input: VADLiveProcessInput
): Promise<VADPipelineHandle>;
```

```ts
const pipeline = await engine.process({
  audioIn,
  segmentOut,
  options: { chunkSize: 512, autoFlushOnInputEnded: true },
});
pipeline.onSpeechStateChanged = (e) => console.log(e.isSpeechDetected);
```

### `engine.process(input)` — offline batch

Runs a single offline VAD pass (or segmented pass with `mode: 'auto'`). Returns `VADOfflineResult` with `summary` and `segmentBufferId`.

```ts
process(
  input: VADOfflineProcessInput
): Promise<VADOfflineResult>;
```

```ts
const { summary, segmentBufferId } = await engine.process({
  audioIn: offlineAudio,
  segmentOut: offlineSegOut,
});
console.log(summary.segmentCount, segmentBufferId);
```

### `engine.isSpeechDetected()`

Returns the current VAD speech state without polling the pipeline handle.

```ts
isSpeechDetected(): Promise<boolean>;
```

```ts
const speechNow = await engine.isSpeechDetected();
```

### `engine.destroy()`

Releases the native VAD instance (joins any live workers first).

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

### `pipeline.onSpeechStateChanged`

Assign after `process` returns to receive VAD speech/activity without polling. Throttle with `speechStateEventMinIntervalMs` in `VADLiveRunOptions`.

```ts
onSpeechStateChanged?: (event: VADSpeechStateChangedEvent) => void;
```

### `pipeline.stop()`

**Hard teardown** of the VAD worker. Resolves after native teardown; the pipeline id is then **terminal** (later control calls may return `VAD_PIPELINE_NOT_FOUND`).

```ts
stop(): Promise<void>;
```

### `pipeline.flush()`

**Drain barrier:** forces the worker to **process pending audio** and flush internal state into **`segmentOut`** where applicable. Use when **`autoFlushOnInputEnded`** is **false** or when coordinating **multiple** pipelines on the same audio (flush VAD and STT before stops). **Do not** call after **`finalizeLiveAudioBuffer`** when **`autoFlushOnInputEnded: true`** — finalize already ran terminal draining (see quick start comment).

```ts
flush(): Promise<void>;
```

### `pipeline.reset()`

Clears **VAD runtime state** (e.g. hangover counters) while keeping the pipeline registered; semantics follow native `resetStreamingPipeline` for this worker.

```ts
reset(): Promise<void>;
```

### `pipeline.getStatus()`

Snapshot of worker progress and VAD-specific flags (see `VADPipelineStatus` in Types).

```ts
getStatus(): Promise<VADPipelineStatus>;
```

### `pipeline.completed`

Resolves when the worker has **fully stopped** (normal completion after finalize + auto-flush, `stop()`, or error). Use with **`await finalizeLiveAudioBuffer`** in the graceful path shown in the quick start.

## Speech payload (`source: 'vad'`)

Every committed VAD span written to `segmentOut` is `kind: 'speech'` with this payload. Downstream features (SID label, alignment `mode: 'vad'`, …) can filter on `payload.source === 'vad'` without re-running detection.

```ts
{
  source: 'vad';
  engine?: 'vad';
  decision?: 'model';
  score?: number;
}
```

`score` is the mean speech probability over the span when available. See [segmentbuffer-streaming.md](segmentbuffer-streaming.md#segment-payload-contracts).

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

---


## JS Events

| Callback | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onSpeechStateChanged` | `VADSpeechStateChangedEvent` | speech / non-speech transition | assign on `VADPipelineHandle`; throttle with `speechStateEventMinIntervalMs` |
| `onSegmentAppended` | `LiveSegmentBufferSegmentEvent` | committed speech segment on output buffer | set on `createLiveSegmentBuffer`; live path only |
| `onProgress` | `OrchestrationProgress` | start of each offline segment step | offline segmented only (`mode: 'auto'`); live path: none |

Shapes: [Types](#types).

```ts
pipeline.onSpeechStateChanged = (e) => console.log(e.isSpeechDetected);

const segmentOut = await createLiveSegmentBuffer({
  sourceAudioBufferId: audioIn,
  onSegmentAppended: (e) => console.log(e.segmentId, e.durationMs),
});
```

## Types

### Core VAD types (`react-native-sherpa-onnx/vad`)

| Type | Description |
| --- | --- |
| `VADModelType` | `'silero_vad' \| 'ten_vad'` |
| `VADConcreteModelType` | Alias of `VADModelType` (non-`auto`) |
| `VAD_MODEL_TYPES` | Readonly runtime list of model types |
| `VADDetectResult` | Return of `detectVadModel()` (`success`, `error?`, `modelType`, `detectedModels`, `paths`, `languages`, `quantization`, `detectionSources`) |
| `VADInitializeOptions` | Discriminated union: `VADAutoInitializeOptions \| VADCustomInitializeOptions` |
| `VADInitOptionsShared` | Shared fields: `sampleRate?`, `runtimeOptions?`, `provider?`, `numThreads?`, `debug?` |
| `VADAutoInitializeOptions` | Auto mode: `modelSource`, optional `quantization`, `modelType` |
| `VADCustomInitializeOptions` | Custom mode: `initMode: 'custom'`, `modelType`, `customConfig: VadCustomConfig` |
| `VADRuntimeOptions` | `SileroVadRuntimeOptions \| TenVadRuntimeOptions` — strict model-matched union |
| `VADRuntimeTuningOptions` | `scoreThreshold?`, `minSilenceDurationMs?`, `minSpeechDurationMs?`, `maxSpeechDurationMs?`, `windowSize?` |
| `VADLiveRunOptions` | `chunkSize?`, `autoFlushOnInputEnded?`, `sourceTag?`, `speechStateEventMinIntervalMs?` |
| `VADOfflineRunOptions` | `sourceTag?`, `segmentation?`, `onProgress?` |
| `VADRunOptions` | `VADLiveRunOptions \| VADOfflineRunOptions` |
| `VADLiveProcessInput` | `audioIn` (live), `segmentOut` (live), `options?: VADLiveRunOptions` |
| `VADOfflineProcessInput` | `audioIn` (offline), `segmentOut` (offline or live), `options?: VADOfflineRunOptions` |
| `VADEngine` | `process`, `isSpeechDetected`, `destroy` |
| `VADPipelineHandle` | `instanceId`, `pipelineId`, `completed`, `onSpeechStateChanged?`, `stop`, `flush`, `reset`, `getStatus` |
| `VADPipelineStatus` | `pipelineId`, `isRunning`, `isFlushing`, `queueDepth`, `chunksProcessed`, `unitsRead`, `unitsWritten`, `error` |
| `VADSpeechStateChangedEvent` | `isSpeechDetected`, `pipelineId`, `ts?` |
| `VADSummary` | `chunksProcessed`, `unitsRead`, `unitsWritten`, `segmentCount`, `speechDurationMs` |
| `VADOfflineResult` | `summary: VADSummary`, `segmentBufferId: string` |
| `VadCustomConfig` | `{ model: FileSource }` |
| `VadCustomPathKey` | `'model'` |
| `VadErrorCode` | `{ INVALID_ARGUMENT: 'VAD_INVALID_ARGUMENT' }` |
| `OrchestrationProgress` | Shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …) |
| `DetectionSource` | Trace literals from native detection |
| `DetectedModelEntry` | `{ type: string; modelDir: string }` |

### Related buffer types

| Type | Description |
| --- | --- |
| `LiveAudioBufferIdSource` | Live audio ref or handle passed to `process` (streaming) |
| `OfflineAudioBufferIdSource` | Offline audio ref or handle passed to `process` (batch) |
| `LiveSegmentBufferIdSource` | Live segment buffer for streaming output |
| `OfflineSegmentBufferIdSource` | Offline segment buffer for batch output |

See [audiobuffer-streaming.md](audiobuffer-streaming.md) · [audiobuffer-offline.md](audiobuffer-offline.md) · [segmentbuffer-streaming.md](segmentbuffer-streaming.md).

---

## Error codes

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
