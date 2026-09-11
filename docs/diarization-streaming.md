# Speaker diarization (streaming)

**Status:** Android ✅ · iOS ✅

## Introduction

On-device **true streaming** speaker diarization: continuously identifies "who spoke when"
in real-time audio. Powered by **NeMo Sortformer** running natively on **ONNX Runtime (ORT)**
with high-performance C++ DSP (Radix-2 FFT + sparse Mel filterbanks) and bounded memory
via NeMo smart cache compression.

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Mono PCM audio buffer (`live_*`) drained by native worker |
| **Output** | [`LiveSegmentBuffer`](segmentbuffer-streaming.md) | Live segment buffer (`seg_live_*`); native worker appends segments with `kind: 'diarization'` |
| **Engine** | `StreamingDiarizationEngine` via `createStreamingDiarization` | Starts pipeline, exposes model properties, manual feed/flush/reset |
| **Pipeline Handle** | `DiarizationPipelineHandle` via `engine.startPipeline(...)` | `stop`, `flush`, `reset`, `getStatus`, `completed` |

Import path: `react-native-sherpa-onnx/diarization`

In this guide:
- **`engine`** refers to the `StreamingDiarizationEngine` instance.
- **`pipeline`** refers to the `DiarizationPipelineHandle` returned by `engine.startPipeline(...)`.

For **offline batch diarization** (pyannote + embedding clustering), see [Speaker diarization (offline)](diarization-offline.md).  
For **named speaker timelines** (mapping diarization clusters to enrolled identities via SID), see [Named diarization timeline](diarization-named-timeline.md).

---

## Streaming pipeline system

Calling `engine.startPipeline(audioIn, segmentOut)` registers a **native background worker thread** (`DiarizationStreamingPipelineWorker`):

1. **Drains audio** directly from the native `LiveAudioBuffer` (`PaLiveEntry` on iOS, `LiveEntry` on Android) using cursor handles in chunks (`chunkSize`, default 4096 samples).
2. **Computes Mel spectrograms** using high-performance, zero-allocation C++ DSP (`SortformerFbank`).
3. **Runs Sortformer inference** in ONNX Runtime with persistent FIFO buffers and bounded speaker cache.
4. **Applies post-processing** (channel-wise median filtering + hysteresis thresholding) into time-aligned speaker turns.
5. **Appends segments** directly into the native `LiveSegmentBuffer` (`seg_live_append_segment` on iOS, `outputEntry.appendSegment` on Android) with `kind: 'diarization'` and payload `{"source":"diarization","speaker":S}`.

Shared lifecycle semantics of **`stop` / `flush` / `reset` / `getStatus` / `completed`** are described in **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**.

---

## Quick start

All buffer parameters accept buffer refs directly or raw string IDs.

```ts
import {
  createStreamingDiarization,
  detectDiarizationModel,
} from 'react-native-sherpa-onnx/diarization';
import {
  createEmptyLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyLiveSegmentBuffer,
  getLiveSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

// 1. Detect or provide model source
const det = await detectDiarizationModel({
  kind: 'fs',
  path: '/path/to/diar_streaming_sortformer_4spk-v2.1',
});
if (!det.success || !det.isStreaming) {
  throw new Error('Expected streaming diarization model');
}

// 2. Initialize the streaming diarization engine
const engine = await createStreamingDiarization({
  modelSource: {
    kind: 'fs',
    path: '/path/to/diar_streaming_sortformer_4spk-v2.1',
  },
  modelType: 'sortformer',
  onset: 0.5,
  offset: 0.5,
  minDurationOff: 0.5, // Merge turns from the same speaker separated by <= 0.5s
});

console.log('Model properties:', {
  sampleRate: engine.sampleRate,       // 16000
  maxSpeakers: engine.maxSpeakers,     // 4
  feedSamples: engine.feedSamples,     // 160000 (10.0s window)
  strideSamples: engine.strideSamples, // 158720 (9.92s stride)
  latencySeconds: engine.latencySeconds, // ~10.0s
});

// 3. Set up pipeline buffers
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: engine.sampleRate });
const segmentOut = await createEmptyLiveSegmentBuffer({
  sourceAudioBufferId: audioIn,
  onSegmentAppended: (e) => {
    console.log(`Speaker ${e.segment.payload?.speaker}: ${e.segment.startSample} -> ${e.segment.endSample}`);
  },
});

// 4. Start the streaming pipeline
const pipeline = await engine.startPipeline(audioIn, segmentOut, {
  chunkSize: 4096, // Drain step size from audioIn
});

// 5. Ingest live audio (e.g. from mic)
await startMicToLiveAudioBuffer(audioIn);

// ... recording session ...

// 6. Stop recording and flush final tail segments
await stopMicToLiveAudioBuffer();
await pipeline.flush();
await pipeline.stop();
await pipeline.completed;

// 7. Clean up
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineAudioBuffer(audioIn);
await engine.release();
```

---

## Pipeline flow

| Step | Method | Result |
| --- | --- | --- |
| 1 | `detectDiarizationModel(source)` | Validates Sortformer model files |
| 2 | `createStreamingDiarization(options)` | Allocates C++ DSP & ORT session (`StreamingDiarizationEngine`) |
| 3 | `createEmptyLiveAudioBuffer(...)` | Prepares input live audio buffer (`live_*`) |
| 4 | `createEmptyLiveSegmentBuffer(...)` | Prepares output live segment buffer (`seg_live_*`) |
| 5 | `engine.startPipeline(audioIn, segmentOut, options?)` | Starts native worker thread (`DiarizationPipelineHandle`) |
| 6 | `startMicToLiveAudioBuffer(audioIn)` / file ingest | Audio drains natively into DSP & ORT |
| 7 | `onSegmentAppended` / segment buffer reads | Live speaker turns emitted in real time |
| 8 | `pipeline.flush()` $\rightarrow$ `pipeline.stop()` $\rightarrow$ `pipeline.completed` | Flushes trailing audio and halts worker |
| 9 | `releasePipeline*Buffer(...)` + `engine.release()` | Frees buffers and unloads ONNX model |

---

## Models & metadata

Streaming diarization uses **NeMo Sortformer** ONNX models (e.g. `diar_streaming_sortformer_4spk-v2.1`).

### Archive & folder structure

```
diar_streaming_sortformer_4spk-v2.1/
├── model.onnx          # or model.int8.onnx (required)
├── metadata.json       # optional streaming constants
└── LICENSE             # model license
```

### Dynamic metadata extraction & fallback

The C++ streaming engine dynamically configures its tensor shapes and parameters (`chunk_len`, `right_context`, `fifo_len`, `spkcache_len`, `max_speakers`, `feature_dim`, `sample_rate`) via:
1. **`metadata.json`** file if provided alongside the model.
2. **Embedded ONNX `metadata_props`** fallback if `metadata.json` is missing.
3. Default Sortformer v2.1 constants if neither is present.

### Download Manager integration

Sortformer models can be discovered and downloaded via the built-in [Download Manager](download-manager.md):

```ts
import { downloadModel, getModelById, ModelCategory } from 'react-native-sherpa-onnx/download';

const model = await getModelById('diar_streaming_sortformer_4spk-v2.1', ModelCategory.Diarization);
const downloaded = await downloadModel(model, {
  onProgress: (p) => console.log(`Downloading: ${(p.fraction * 100).toFixed(1)}%`),
});
```

---

## API reference

All signatures below are exported from **`react-native-sherpa-onnx/diarization`**.

### `detectDiarizationModel(source, options?)`

Inspects the provided file source. For Sortformer streaming models, returns `isStreaming: true` and populates `paths.model` and optional `paths.metadata`. Unified detection: [model-detect.md](model-detect.md).

```ts
function detectDiarizationModel(
  source: FileSource,
  options?: { modelType?: DiarizationModelKind | 'auto'; assetName?: string; debug?: boolean }
): Promise<DiarizationDetectResult>;
```

```ts
const det = await detectDiarizationModel({
  kind: 'fs',
  path: '/data/models/diar_streaming_sortformer_4spk-v2.1',
});
console.log(det.isStreaming); // true
console.log(det.modelType);   // 'sortformer'
```

### `createStreamingDiarization(options)`

Creates and initializes the native streaming diarization engine. Init modes: **`auto`** (default — `modelSource` + optional `modelType`) or **`custom`** (`initMode: 'custom'` + `customConfig: { model, metadata? }`). Shared tuning: `onset`, `offset`, `padOnset`, `padOffset`, `minDurationOn`, `minDurationOff`, `medianWindow`, `chunkLen`, `rightContext`, `fifoLen`, `numThreads`, `provider`, `debug`.

```ts
function createStreamingDiarization(
  options: StreamingDiarizationInitializeOptions
): Promise<StreamingDiarizationEngine>;
```

```ts
// Auto mode
const engine = await createStreamingDiarization({
  modelSource: { kind: 'fs', path: '/path/to/sortformer-folder' },
  modelType: 'sortformer',
  onset: 0.5,
  offset: 0.5,
  minDurationOff: 0.5,
});

// Custom mode
const engine = await createStreamingDiarization({
  initMode: 'custom',
  modelType: 'sortformer',
  customConfig: {
    model: { kind: 'fs', path: '/path/to/sortformer.onnx' },
    metadata: { kind: 'fs', path: '/path/to/metadata.json' },
  },
});
```

Engine read-only properties after init: `instanceId`, `sampleRate` (always `16000`), `maxSpeakers` (e.g. `4`), `feedSamples`, `strideSamples`, `latencySeconds`.

### `engine.startPipeline(audioIn, segmentOut, options?)`

Starts a native background worker thread draining `audioIn` and appending speaker turns to `segmentOut`. `audioIn` must be a live audio buffer (`live_*`); `segmentOut` must be a live segment buffer (`seg_live_*`).

```ts
startPipeline(
  audioIn: LiveAudioBufferIdSource,
  segmentOut: LiveSegmentBufferIdSource,
  options?: StreamingDiarizationOptions
): Promise<DiarizationPipelineHandle>;
```

```ts
const pipeline = await engine.startPipeline(audioIn, segmentOut, { chunkSize: 4096 });
```

### `engine.feed(audioIn)`

Manually feeds an offline audio buffer to the engine's accumulation buffer. If enough audio has accumulated (≥ feed window), triggers forward steps and returns newly finalized segments.

```ts
feed(
  audioIn: OfflineAudioBufferIdSource
): Promise<Array<{ start: number; end: number; speaker: number }>>;
```

```ts
const segments = await engine.feed(offlineAudioBuf);
```

### `engine.flush()`

Flushes remaining trailing audio in the accumulation buffer (zero-padding to window size), post-processes final predictions, and returns final segments.

```ts
flush(): Promise<Array<{ start: number; end: number; speaker: number }>>;
```

```ts
const tailSegments = await engine.flush();
```

### `engine.reset()`

Resets internal streaming state: clears the FIFO buffer, speaker cache, silence tracking profile, and audio accumulator.

```ts
reset(): Promise<void>;
```

```ts
await engine.reset();
```

### `engine.release()`

Unloads the native ONNX Runtime session, frees C++ DSP scratch buffers, and unregisters the native instance.

```ts
release(): Promise<void>;
```

```ts
await engine.release();
```

### `pipeline.stop()`

Signals the worker thread to stop and unregisters the pipeline. Call before releasing the associated audio and segment buffers.

```ts
stop(): Promise<void>;
```

### `pipeline.flush()`

Forces an in-band flush of any buffered audio while the pipeline continues running.

```ts
flush(): Promise<void>;
```

### `pipeline.reset()`

Resets the native engine state in-band without stopping the pipeline worker.

```ts
reset(): Promise<void>;
```

### `pipeline.getStatus()`

Returns current metrics for the pipeline worker.

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsWritten);
```

### `pipeline.completed`

A Promise that settles when the worker loop exits (normally or via error).

```ts
readonly completed: Promise<StreamingPipelineCompletion>;
```

```ts
await pipeline.completed;
// { pipelineId, reason: 'completed' | 'stopped' | 'error', chunksProcessed, unitsRead, unitsWritten, error }
```

---

### Streaming latency profiles

NeMo Sortformer supports dynamic sequence lengths. Configure `chunkLen`, `rightContext`, and `fifoLen` to trade off latency vs accuracy:

| Profile | `chunkLen` | `rightContext` | `fifoLen` | Latency | Stride (Update Rate) | Use Case |
| --- | --- | --- | --- | --- | --- | --- |
| **Low Latency** *(recommended for live mic)* | `6` | `7` | `188` | **1.04s** | **0.48s** (~2 updates/sec) | Interactive real-time mic streaming & live meetings |
| **Ultra-Low Latency** | `3` | `1` | `188` | **0.32s** | **0.24s** (~4 updates/sec) | Ultra-fast speaker change detection |
| **High Latency (Default)** | `124` | `1` | `124` | **10.00s** | **9.92s** (~1 update / 10s) | Pre-recorded file ingestion & maximum DER accuracy |

```ts
const engine = await createStreamingDiarization({
  modelSource: { kind: 'fs', path: '/path/to/sortformer-folder' },
  chunkLen: 6,
  rightContext: 7,
  fifoLen: 188,
});
console.log(engine.latencySeconds); // 1.04
```

---

## Pipeline buffers (audio input + segment output)

### Audio input (`LiveAudioBuffer`)

```ts
import {
  createEmptyLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

- Must be created with `sampleRate: 16000` (Sortformer's expected rate).
- Can be fed by the microphone (`startMicToLiveAudioBuffer`) or upstream file ingestion (`startFileIngestToLiveAudioBuffer`).
- See [audiobuffer — live / streaming](audiobuffer-streaming.md).

### Segment output (`LiveSegmentBuffer`)

```ts
import {
  createEmptyLiveSegmentBuffer,
  getLiveSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';
```

- Segments are appended with `kind: 'diarization'`.
- `payloadJson` contains `{"source":"diarization","speaker":S}` where `S` is an integer index ($0$ to $\text{maxSpeakers}-1$).
- See [segmentbuffer — live / streaming](segmentbuffer-streaming.md).

#### Observing committed speaker segments

Committed speaker turns are emitted as segments on the output `LiveSegmentBuffer`. Subscribe to `onSegmentAppended` (or `streamEvents.segmentAppended`):

```ts
const segmentOut = await createEmptyLiveSegmentBuffer({
  sourceAudioBufferId: audioIn,
  onSegmentAppended: (e) => {
    const speaker = e.segment.payload?.speaker;
    console.log(`[Speaker ${speaker}] ${e.segment.startSample} -> ${e.segment.endSample} (${e.segment.durationMs}ms)`);
  },
});
```

---

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Mic live ingestion | `LiveAudioBuffer` (`live_*`) | Microphone feeds audio directly to input buffer |
| File live ingestion | `startFileIngestToLiveAudioBuffer` | Real-time file playback into live buffer |
| Denoised audio | `StreamingEnhancementEngine` | Clean speech output feeds diarization input |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Speaker turn events | `LiveSegmentBuffer.onSegmentAppended` | Real-time speaker activity detection |
| Named timeline mapping | `mapDiarizationToNames` | Combines diarization clusters with SID enrollment gallery |
| UI timeline rendering | `LiveSegmentBuffer` reads | Renders live speaker diarization ribbons in the UI |

```mermaid
flowchart LR
  Mic[Microphone / Ingest] --> LiveAudio[LiveAudioBuffer 16kHz]
  LiveAudio --> NativeWorker[DiarizationStreamingPipelineWorker]
  subgraph NativeEngine [Native C++ Streaming Engine]
    NativeWorker --> Fbank[SortformerFbank DSP]
    Fbank --> ORT[Sortformer ONNX Runtime]
    ORT --> PostProc[Post Processor]
  end
  PostProc --> LiveSeg[LiveSegmentBuffer kind: diarization]
  LiveSeg --> UI[Real-time Speaker Timeline UI]
  LiveSeg --> SID[Speaker Identification]
```

---

## Types

### Streaming diarization types (`react-native-sherpa-onnx/diarization`)

| Type | Description |
| --- | --- |
| `StreamingDiarizationConcreteModelType` | `'sortformer'` |
| `StreamingDiarizationModelType` | `'sortformer' \| 'auto'` |
| `StreamingDiarizationInitOptionsShared` | Shared tuning: `onset`, `offset`, `padOnset`, `padOffset`, `minDurationOn`, `minDurationOff`, `medianWindow`, `chunkLen`, `rightContext`, `fifoLen`, `numThreads`, `provider`, `debug` |
| `StreamingDiarizationAutoInitializeOptions` | Auto init: `modelSource`, `quantization?`, `modelType?` + shared tuning |
| `StreamingDiarizationCustomInitializeOptions` | Custom init: `initMode: 'custom'`, `modelType`, `customConfig: { model, metadata? }` + shared tuning |
| `StreamingDiarizationInitializeOptions` | Union of auto and custom init options |
| `StreamingDiarizationOptions` | Pipeline start options: `{ chunkSize?: number }` |
| `StreamingDiarizationEngine` | `startPipeline`, `feed`, `flush`, `reset`, `release` + read-only props (`instanceId`, `sampleRate`, `maxSpeakers`, `feedSamples`, `strideSamples`, `latencySeconds`) |
| `DiarizationPipelineHandle` | `stop`, `flush`, `reset`, `getStatus`, `completed` + read-only `instanceId`, `pipelineId` |
| `DiarizationDetectResult` | Return of `detectDiarizationModel()` |
| `DiarizationCustomConfig` | `{ model: FileSource; metadata?: FileSource }` |

### Shared pipeline types (`react-native-sherpa-onnx/audiobuffer`)

| Type | Description |
| --- | --- |
| `StreamingPipelineStatus` | `{ pipelineId, isRunning, chunksProcessed, unitsRead, unitsWritten, error }` |
| `StreamingPipelineCompletion` | `{ pipelineId, reason: 'completed' \| 'stopped' \| 'error', chunksProcessed, unitsRead, unitsWritten, error }` |

### Related buffer types

| Type | Description |
| --- | --- |
| `LiveAudioBufferIdSource` | Live audio ref passed to `startPipeline` |
| `LiveSegmentBufferIdSource` | Live segment buffer for pipeline output |
| `OfflineAudioBufferIdSource` | Offline audio ref passed to `engine.feed` |

See [audiobuffer-streaming.md](audiobuffer-streaming.md) · [segmentbuffer-streaming.md](segmentbuffer-streaming.md).

---

## Platform notes

- **Android**:
  - Worker thread runs in `DiarizationStreamingPipelineWorker.kt`.
  - Audio drained from `LiveEntry` cursor $\rightarrow$ JNI $\rightarrow$ `StreamingDiarizationWrapper` $\rightarrow$ `LiveSegmentEntry.appendSegment(...)`.
  - Runs on ONNX Runtime mobile library with CPU or NNAPI/QNN providers.
- **iOS**:
  - Worker thread runs in `DiarizationStreamingPipelineWorker.mm`.
  - Audio drained from `PaLiveEntry` cursor $\rightarrow$ C++ `StreamingDiarizationWrapper` $\rightarrow$ `seg_live_append_segment(...)`.
  - Direct C++ memory access.
- **DSP & Inference**:
  - 100% portable C++ DSP (`SortformerFbank`): Radix-2 FFT with precomputed twiddle tables, periodic Hann window, and sparse Slaney Mel filterbank.
  - Zero dynamic heap allocation in steady-state streaming loops.
  - NeMo Smart Cache Compression bounds RAM usage to constant size over infinite streaming sessions.

---

## Error codes

| Error code | Explanation |
| --- | --- |
| `DETECT_ERROR` | Model detection failed or input directory is invalid. |
| `DIARIZATION_INIT_ERROR` | Engine initialization failed (missing model file, invalid ONNX structure, or ORT initialization error). |
| `DIARIZATION_ERROR` | General streaming runtime error (e.g. pipeline start failure, invalid state transition). |
| `DIARIZATION_BUFFER_NOT_FOUND` | Referenced audio or segment buffer ID does not exist or was already released. |
| `DIARIZATION_NOT_INITIALIZED` | An operation was invoked on an engine or native instance that is not initialized. |
| `DIARIZATION_INVALID_ARGUMENT` | Missing or malformed parameters (e.g. non-live buffer passed to `startPipeline`). |
| `STREAMING_PIPELINE_ERROR` | Fatal pipeline worker thread exception. |

---

## Live overload — intentionally out of scope

Diarization will **not** receive a live-overload API (offline weights on live buffers via the shared segmentation engine), and that is **not** planned for the future.

### Why

- Offline diarization already runs **pyannote sliding windows** internally inside one `diarize` call. The segmentation engine is not needed to keep model inputs window-sized or prevent OOM.
- Live overload commits slices and runs the **offline** feature per commit (as with SID). Per-slice `diarize` yields **local** cluster IDs without stable speaker identity across the session (e.g. cluster 0 in chunk A could be speaker 2 in chunk B), resulting in poor live tracking.
- Solving that would require session-wide re-clustering or maintaining custom cross-chunk state — an entirely different architecture that is fundamentally what true streaming models like Sortformer do.

### What to use instead

| Need | Path |
| --- | --- |
| Batch who-spoke-when | Offline `createDiarization` / `diarize` ([diarization-offline.md](./diarization-offline.md)) |
| Live / low-latency diarization | True streaming Sortformer via `createStreamingDiarization` (this guide) |
| Named speakers on an offline timeline | [Named diarization timeline (SID × Diarization)](./diarization-named-timeline.md) |

*(Contrast: SID **does** provide live overload (`labelLiveSegments`) because each speech utterance is independently matched against a fixed enrollment gallery — a composition that does not apply to anonymous unsupervised clustering).*
