# Speaker diarization (streaming)

**Status:** Android ✅ · iOS ✅

## Introduction

On-device **true streaming** speaker diarization: detects who spoke when continuously
in real-time audio. Powered by **NeMo Sortformer** running natively on **ONNX Runtime (ORT)**
with high-performance C++ DSP (Radix-2 FFT + sparse Mel filterbanks), bounded memory
via NeMo smart cache compression, and **zero JS roundtrips**.

Import path: `react-native-sherpa-onnx/diarization`

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Mono PCM audio buffer (`live_*`) drained by native worker |
| **Output** | [`LiveSegmentBuffer`](segmentbuffer.md) | Live segment buffer (`seg_live_*`); native worker appends segments with `kind: 'diarization'` |
| **Engine** | `StreamingDiarizationEngine` via `createStreamingDiarization` | Starts pipeline, exposes model properties, manual feed/flush/reset |
| **Pipeline Handle** | `DiarizationPipelineHandle` via `startPipeline` | `stop`, `flush`, `reset`, `getStatus`, `completed` |

Offline batch diarization: [diarization-offline.md](./diarization-offline.md).  
Named speaker timelines (Diarization × SID): [diarization-named-timeline.md](./diarization-named-timeline.md).

---

## Streaming pipeline system (Zero JS Roundtrips)

When you call `engine.startPipeline(audioIn, segmentOut)`, the SDK spawns a dedicated native worker thread (`DiarizationStreamingPipelineWorker`):
1. **Drains audio** directly from `LiveAudioBuffer` (`PaLiveEntry` on iOS, `LiveEntry` on Android) via cursor handles.
2. **Computes Mel spectrograms** using zero-allocation C++ DSP (`SortformerFbank`).
3. **Runs Sortformer inference** in ONNX Runtime with persistent FIFO and compressed speaker cache.
4. **Post-processes predictions** (median filtering + hysteresis thresholding) into time-aligned speaker segments.
5. **Appends segments** directly into `LiveSegmentBuffer` (`seg_live_append_segment` on iOS, `outputEntry.appendSegment` on Android).

No intermediate audio frames or raw speaker tensors cross the React Native JavaScript bridge during steady-state processing.

---

## Quick start

```ts
import { createStreamingDiarization } from 'react-native-sherpa-onnx/diarization';
import {
  createEmptyLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyLiveSegmentBuffer,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

// 1. Initialize the streaming diarization engine
const engine = await createStreamingDiarization({
  modelSource: {
    kind: 'fs',
    path: '/path/to/diar_streaming_sortformer_4spk-v2.1',
  },
  modelType: 'sortformer',
  onset: 0.5,
  offset: 0.5,
  minDurationOff: 0.5, // Merge segments closer than 0.5s
});

console.log('Model properties:', {
  sampleRate: engine.sampleRate,       // 16000
  maxSpeakers: engine.maxSpeakers,     // 4
  feedSamples: engine.feedSamples,     // 160000 (10.0s window)
  strideSamples: engine.strideSamples, // 158720 (9.92s stride)
  latencySeconds: engine.latencySeconds, // ~10.0s
});

// 2. Set up pipeline buffers
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: engine.sampleRate });
const segmentOut = await createEmptyLiveSegmentBuffer({
  sourceAudioBufferId: audioIn,
  onSegmentAppended: (e) => {
    // Fired whenever a new speaker segment is finalized
    console.log(`Speaker ${e.segment.payload?.speaker}: ${e.segment.startSample} -> ${e.segment.endSample}`);
  },
});

// 3. Start the zero-JS native streaming pipeline
const pipeline = await engine.startPipeline(audioIn, segmentOut, {
  chunkSize: 4096, // Drain step size from audioIn
});

// 4. Feed audio to audioIn (e.g. from mic or file ingest)...
// When done feeding:
await pipeline.flush();
await pipeline.stop();
await pipeline.completed;

// 5. Clean up
await releasePipelineSegmentBuffer(segmentOut);
await releasePipelineAudioBuffer(audioIn);
await engine.release();
```

---

## Models & Metadata

Streaming diarization uses **NeMo Sortformer** ONNX models (e.g. `diar_streaming_sortformer_4spk-v2.1`).

An archive or model directory typically contains:
* `model.onnx` or `model.int8.onnx` (required)
* `metadata.json` (optional, provides streaming chunk dimensions; if absent, the native C++ engine automatically extracts the metadata properties directly from the ONNX model graph)
* `LICENSE`

Sortformer models can be downloaded automatically via the built-in [Download Manager](download-manager.md) (`ModelCategory.Diarization`).

---

## API Reference

### `createStreamingDiarization(options)`

Initializes the native C++ streaming diarization engine and loads the ONNX Runtime session.

#### Options (`StreamingDiarizationInitializeOptions`)

Supports either **Auto** or **Custom** initialization mode:

##### Auto Mode (`StreamingDiarizationAutoInitializeOptions`)
| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `modelSource` | `FileSource` | **Required** | Directory containing the Sortformer ONNX model |
| `modelType` | `'sortformer' \| 'auto'` | `'auto'` | Model architecture selector |
| `initMode` | `'auto'` | `'auto'` | Initialization mode |

##### Custom Mode (`StreamingDiarizationCustomInitializeOptions`)
| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `initMode` | `'custom'` | **Required** | Must be `'custom'` |
| `modelType` | `'sortformer'` | **Required** | Must be `'sortformer'` |
| `customConfig` | `DiarizationCustomConfig` | **Required** | `{ model: FileSource, metadata?: FileSource }` |

##### Shared Tuning Options (`StreamingDiarizationInitOptionsShared`)
| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onset` | `number` | `0.5` | Hysteresis onset activation threshold |
| `offset` | `number` | `0.5` | Hysteresis offset deactivation threshold |
| `padOnset` | `number` | `0.0` | Seconds to pad before segment start |
| `padOffset` | `number` | `0.0` | Seconds to pad after segment end |
| `minDurationOn` | `number` | `0.0` | Minimum active speech duration (s) to keep |
| `minDurationOff` | `number` | `0.5` | Maximum silence gap (s) between consecutive speaker turns to merge |
| `medianWindow` | `number` | `11` | Median filter window length across time frames |
| `numThreads` | `number` | `1` | CPU inference threads |
| `provider` | `string` | `'cpu'` | ONNX Runtime execution provider |
| `debug` | `boolean` | `false` | Enable verbose native logging |

---

### `StreamingDiarizationEngine`

Instance returned by `createStreamingDiarization`.

#### Properties (Read-Only)
* `instanceId`: Unique instance identifier (e.g. `diar_stream_1`).
* `sampleRate`: Audio sample rate expected by the model (typically `16000`).
* `maxSpeakers`: Maximum number of concurrent speaker tracks supported by the model (e.g. `4`).
* `feedSamples`: Number of audio samples required per forward pass (e.g. `160000` = 10.0s).
* `strideSamples`: Number of new audio samples advanced between passes (e.g. `158720` = 9.92s).
* `latencySeconds`: Algorithmic latency in seconds (e.g. `10.0`).

#### Methods

##### `startPipeline(audioIn, segmentOut, options?): Promise<DiarizationPipelineHandle>`
Starts the native background worker thread connecting `audioIn` to `segmentOut`.
* `audioIn`: Live audio buffer or buffer ID (`live_*`).
* `segmentOut`: Live segment buffer or buffer ID (`seg_live_*`).
* `options.chunkSize`: Number of samples read per drain cycle (default `4096`).

##### `feed(audioIn): Promise<Array<{ start: number, end: number, speaker: number }>>`
Manually feeds an offline audio buffer (`audioIn: OfflineAudioBufferIdSource`). Returns any newly finalized segments.

##### `flush(): Promise<Array<{ start: number, end: number, speaker: number }>>`
Flushes any remaining audio in the accumulation buffer (zero-padding to window size) and returns final segments.

##### `reset(): Promise<void>`
Resets internal streaming states (clears FIFO buffer, speaker cache, and silence profile).

##### `release(): Promise<void>`
Unloads the ONNX Runtime model session and frees native resources.

---

### `DiarizationPipelineHandle`

Handle returned by `engine.startPipeline(...)`.

* `pipelineId`: Unique ID of the running pipeline.
* `completed`: Promise that resolves with `StreamingPipelineCompletion` when the worker terminates (or rejects on fatal error).
* `stop(): Promise<void>`: Requests the worker to terminate.
* `flush(): Promise<void>`: Forces an in-band flush of currently buffered audio without stopping.
* `reset(): Promise<void>`: Resets engine state in-band.
* `getStatus(): Promise<StreamingPipelineStatus>`: Returns current processing metrics (`chunksProcessed`, `unitsRead`, `unitsWritten`, `isRunning`, `error`).

---

## Live overload — intentionally out of scope

Diarization will **not** get a live-overload API (offline weights on live buffers
via the shared segmentation engine), and that is **not** planned later either.

**Why**

- Offline diarization already runs **pyannote sliding windows** inside one
  `diarize` call. The segmentation engine is not needed to keep model inputs
  window-sized.
- Live overload commits slices and runs the **offline** feature per commit (as
  with SID). Per-slice `diarize` yields **local** cluster IDs without stable
  speaker identity across the session — poor “who spoke when” live.
- Fixing that would mean session-wide re-clustering or custom state across
  commits — a different design than live overload, closer to true streaming.

**What to use instead**

| Need | Path |
| --- | --- |
| Batch who-spoke-when | Offline `createDiarization` / `diarize` ([diarization-offline.md](./diarization-offline.md)) |
| Live / low-latency diarization | True streaming Sortformer via `createStreamingDiarization` (this guide) |
| Named speakers on an offline timeline | [diarization-named-timeline.md](./diarization-named-timeline.md) |

Contrast: SID **does** ship live overload (`labelLiveSegments`) because each
utterance is independently matched to a fixed enrollment gallery — that
composition does not apply to anonymous clustering diarization.
