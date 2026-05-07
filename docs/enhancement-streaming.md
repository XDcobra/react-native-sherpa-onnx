# Speech enhancement (streaming)

## Introduction

On-device streaming speech denoising with a **pipeline-first** API:

- **Input:** live pipeline audio buffer ([`audiobuffer` — live / streaming](audiobuffer-streaming.md)) — ring/spool buffer the denoiser **drains** (mic, append, or upstream native pipeline).
- **Output:** live pipeline audio buffer ([`audiobuffer` — live / streaming](audiobuffer-streaming.md)) — separate live buffer; native worker **appends** denoised PCM (`source: "enhancement"` on append events).
- **Engine:** `createStreamingEnhancement` exposes **`enhance(audioIn, audioOut)`** → `Promise<EnhancementPipelineHandle>` (plus `getSampleRate` / `getFrameShiftInSamples` / `destroy`). There is **no** JS API to push raw sample arrays into the online denoiser; control the running worker via **`EnhancementPipelineHandle`** (`flush`, `stop`, `reset`, `getStatus`). In this guide **`denoiser`** means the returned `StreamingEnhancementEngine` and **`pipeline`** means that handle.

Import path: `react-native-sherpa-onnx/enhancement`

For **offline batch** enhancement (`OfflineAudioBuffer` → `OfflineAudioBuffer`), see [Speech enhancement (offline)](enhancement-offline.md).

For **offline STT / TTS / alignment** composition with pipeline buffers, see [stt-offline.md](stt-offline.md), [tts-offline.md](tts-offline.md), and [alignment-offline.md](alignment-offline.md).

If the enhancement model rate is not `16000`, set live buffer `sampleRate` (or ingest decode target) explicitly to the model rate from `getSampleRate()`.

## Models and paths

- **`FileSource`:** `FileSource` (from `react-native-sherpa-onnx/fileio`, same as STT/TTS).
- In-app downloads: [download-manager.md](download-manager.md) with category **`ModelCategory.Enhancement`** (when exposed in your app catalog).
- Model detection without loading the denoiser: **`detectEnhancementModel(...)`** (same rules as offline; see [Model detection](enhancement-offline.md#model-detection) on the offline page for the full rule list).
- File expectations per family: [model-setup.md](model-setup.md) where applicable.

---

## Model detection

`detectEnhancementModel` does **not** load the denoiser — use it as a **pre-check** before **`createStreamingEnhancement`** (same idea as `detectTtsModel` / `detectSttModel`).

**Rules (directory scan):**

- Recursively finds `.onnx` under the resolved model directory (depth 4, same family as other detectors).
- Filename / path contains `gtcrn` → candidate **`gtcrn`**; contains `dpdfnet` or `dpcrn` → candidate **`dpdfnet`**.
- **`modelType: 'auto'`** (default): prefers **`gtcrn`** if both ONNX stacks are present, else **`dpdfnet`**.
- **`assetName`:** optional. If omitted, native catalog hints use the **last segment** of `modelSource.path` (with common archive suffixes stripped). If set, that string wins for **`languages`** / **`quantization`** when both directory and asset id are passed to native.

**`detectionSources`:** optional ordered trace (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`). **`nameOnly`** means no file list was scanned — see native `error` when `success` is false.

---

## Quick start

All buffer parameters accept refs directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT`.

**`inputBuf`** / **`outputBuf`** below are the **input** and **output** live pipeline buffers from the intro; PCM moves natively between them while the worker runs — no per-chunk JS bridging for steady-state audio.

```ts
import { createStreamingEnhancement } from 'react-native-sherpa-onnx/enhancement';
import {
  createEmptyLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const denoiser = await createStreamingEnhancement({
  modelSource: { kind: 'fs', path: '/absolute/path/to/enhancement-model-dir' },
  modelType: 'auto',
});

const sr = await denoiser.getSampleRate();
const inputBuf = await createEmptyLiveAudioBuffer({ sampleRate: sr });
const outputBuf = await createEmptyLiveAudioBuffer({
  sampleRate: sr,
  onFramesAppended: (e) => {
    if (e.source !== 'enhancement') return;
    // Denoised frames landed in outputBuf — e.g. drive a meter, waveform, or downstream STT.
    console.log(
      'enhanced frames',
      e.frameCount,
      'total',
      e.totalSamplesWritten,
      e.sampleRate
    );
    // Example line printed: enhanced frames 512 total 2048 16000
  },
});

const pipeline = await denoiser.enhance(inputBuf, outputBuf);

// Mic or other source feeds inputBuf; the pipeline appends to outputBuf and fires onFramesAppended.

await pipeline.stop();
outputBuf.unsubscribeEvents();
inputBuf.unsubscribeEvents();
await releasePipelineAudioBuffer(inputBuf);
await releasePipelineAudioBuffer(outputBuf);
await denoiser.destroy();
```

The pipeline handle supports **`flush()`** / **`reset()`** / **`getStatus()`** while running. When the input buffer **finalizes**, the worker auto-flushes and stops.

---

## Data model and lifetime

| Item | Behaviour |
| --- | --- |
| **`StreamingEnhancementEngine`** | From **`createStreamingEnhancement`** (the **denoiser** in examples). **`destroy()`** releases native **`OnlineSpeechDenoiser`**. |
| **Pipeline handle** | Returned by **`enhance()`** as **`EnhancementPipelineHandle`**. **`stop()`** / **`flush()`** / **`reset()`** / **`getStatus()`**. Registered in **`StreamingPipelineRegistry`**. |

---

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional **`provider`** on init; see [execution-providers.md](execution-providers.md) |
| Live buffers | Float PCM at the **model sample rate**; input/output **`LiveAudioBuffer`** sample rates must match **`getSampleRate()`** |
| Instance lifetime | **`destroy()`** the denoiser; **`releasePipelineAudioBuffer()`** on buffers; **`pipeline.stop()`** before tearing down buffers |

---

## API reference

Signatures below are exported from **`react-native-sherpa-onnx/enhancement`** unless noted. Types live in **`src/enhancement/types.ts`** and **`src/enhancement/streamingTypes.ts`**.

### Detection

#### `detectEnhancementModel(source, options?)`

```ts
function detectEnhancementModel(
  source: FileSource,
  options?: {
    modelType?: EnhancementModelType | 'auto';
    assetName?: string;
  }
): Promise<EnhancementDetectResult>;
```

```ts
const det = await detectEnhancementModel(
  { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-speech-enhancement-gtcrn' },
  { modelType: 'auto' }
);
console.log(det.success, det.modelType, det.detectedModels);
```

```ts
const det2 = await detectEnhancementModel(
  { kind: 'fs', path: '/data/enhancement-pack' },
  { modelType: 'auto', assetName: 'sherpa-onnx-speech-enhancement-gtcrn-int8' }
);
```

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

### Initialization

#### `createStreamingEnhancement(options)`

```ts
function createStreamingEnhancement(
  options: StreamingEnhancementInitializeOptions
): Promise<StreamingEnhancementEngine>;
```

```ts
const denoiser = await createStreamingEnhancement({
  modelSource: { kind: 'fs', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
});
```

Creates the native online denoiser instance. Use **`denoiser.enhance`** with **`LiveAudioBuffer`** ids to run a pipeline; read PCM from the **output** buffer (not from a JS return value).

### Denoiser instance (`StreamingEnhancementEngine`)

#### `denoiser.enhance(inputBuffer, outputBuffer)`

```ts
enhance(
  inputBufferId: string,
  outputBufferId: string,
  options?: StreamingEnhancementEnhanceOptions
): Promise<EnhancementPipelineHandle>;
```

Starts a native background thread that:

1. Creates a cursor on the input `LiveAudioBuffer`.
2. Drains `frameShiftInSamples` samples per iteration.
3. Runs them through the denoiser.
4. Appends enhanced output to the output `LiveAudioBuffer` with source `"enhancement"`.
5. When the input buffer finalizes → auto-flushes and stops.

**Requirements:**

- Both buffers must be **`LiveAudioBuffer`** (kind `livePcmBuffer`).
- The input buffer must be in **`recording`** state.
- The input buffer's `sampleRate` must match the model's sample rate.

```ts
const pipeline = await denoiser.enhance(inputBuf.bufferId, outputBuf.bufferId);
```

---

#### `denoiser.getSampleRate()`

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await denoiser.getSampleRate();
```

---

#### `denoiser.getFrameShiftInSamples()`

```ts
getFrameShiftInSamples(): Promise<number>;
```

```ts
const shift = await denoiser.getFrameShiftInSamples();
```

---

#### `denoiser.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await denoiser.destroy();
```

---

## Live overload on offline enhancement (restricted)

> Mandatory `segmentation.policy`. Commit-only — no partials.

The offline enhancement engine can drive a live pipeline directly. **Warning:** This is a restricted path. Because the offline engine is designed for monolithic processing, it is wrapped in a segmentation loop that processed fixed-size blocks (using the `continuous_frames` policy). This may introduce audible artifacts at segment boundaries.

```ts
const engine = await createEnhancement({ /* offline init */ });
const pipeline = await engine.enhance(inputBuf, outputBuf, {
  segmentation: { 
    mode: 'auto',
    policy: { evaluator: 'continuous_frames', checkpointIntervalMs: 1000 } 
  },
});

// pipeline.stop() / .flush() / .completed as usual
const completion = await pipeline.completed;
console.log(`Denoised ${completion.unitsWritten} samples`);
```

| Aspect | Live overload (`createEnhancement`) | Streaming engine (`createStreamingEnhancement`) |
| --- | --- | --- |
| Weights | Offline-optimized | Streaming-optimized |
| Boundary handling | Hard split (possible clicks) | Seamless stateful streaming |
| Latency | Per-segment (higher) | Per-frame (lower) |
| Recommendation | Use only for short segments | Preferred for live mic |



### Pipeline handle (`EnhancementPipelineHandle`)

`EnhancementPipelineHandle` extends the generic **`StreamingPipelineHandle`** (same `pipelineId`, `stop` / `flush` / `reset` / `getStatus`) and adds **`instanceId`**: the online denoiser that owns `startEnhancementPipeline`.

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

Stops the pipeline thread and removes it from the registry.

---

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

Flushes the denoiser's internal state (appends tail samples to output). The pipeline **continues running** after flush.

---

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

Resets the denoiser's internal state. The pipeline **continues running** after reset.

---

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
interface StreamingPipelineStatus {
  pipelineId: string;
  isRunning: boolean;
  chunksProcessed: number;
  unitsRead: number;
  unitsWritten: number;
  error: string | null;
}
```

## Pipeline buffers (audio input + audio output)

**Audio input**

```ts
import {
  createEmptyLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — live / streaming](audiobuffer-streaming.md) and [audiobuffer — offline](audiobuffer-offline.md).

**Audio output**

```ts
import {
  createEmptyLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  getLiveAudioBufferSamplesSlice,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — live / streaming](audiobuffer-streaming.md) and [audiobuffer — offline](audiobuffer-offline.md).

## Segmentation

Streaming enhancement can attach a segmentation engine to the **input live audio buffer** before the pipeline starts. This is useful when you want deterministic checkpoints or manual boundary control while still processing through one streaming pipeline.

Supported modes for streaming enhancement:

- `'off'` (default): stream continuously without segmentation attachment.
- `'manual'`: segmentation boundaries are controlled externally.
- `'auto'`: segmentation engine attaches automatically to the input buffer.

Current streaming evaluator support is limited to `continuous_frames` (default policy: `checkpointIntervalMs: 1000`).

```ts
import { createStreamingEnhancement } from 'react-native-sherpa-onnx/enhancement';
import { createEmptyLiveAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

const denoiser = await createStreamingEnhancement({
  modelSource: { kind: 'fs', path: '/path/to/model' },
  modelType: 'auto',
});

const sr = await denoiser.getSampleRate();
const inputBuf = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });
const outputBuf = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });

const pipeline = await denoiser.enhance(inputBuf.bufferId, outputBuf.bufferId, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'continuous_frames', checkpointIntervalMs: 1000 },
  },
});

await pipeline.flush();
await pipeline.stop();
await denoiser.destroy();
```

See [segmentation-engine.md](segmentation-engine.md) for the shared model and [memory-and-models.md](memory-and-models.md) for peak-memory planning.

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Mic/file live ingestion | `LiveAudioBuffer` (`live_*`) | Input live buffer remains in recording state while pipeline runs. |
| Pre-existing live chain | `LiveAudioBuffer` (`live_*`) | Can receive audio from upstream live append or ingest handles. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Clean live output | `LiveAudioBuffer` (`live_*`) | Output remains consumable while enhancement is active. |
| Streaming STT | `LiveAudioBuffer` (`live_*`) | Common denoise-first streaming transcription chain. |
| Live playback/finalize | `PcmPlayer` or finalize to offline buffer | Optional playback/export path after pipeline run. |

```mermaid
flowchart LR
  A[LiveAudioBuffer noisy] --> B[createStreamingEnhancement().enhance]
  B --> C[LiveAudioBuffer clean]
  C --> D[Streaming STT or live playback]
```

More end-to-end patterns: [feature-pipelines.md#enhancement-streaming-patterns](feature-pipelines.md#enhancement-streaming-patterns).

## Types and constants

```ts
import {
  ENHANCEMENT_MODEL_TYPES,
  type EnhancementModelType,
  type StreamingEnhancementEngine,
  type StreamingEnhancementInitializeOptions,
  type EnhancementDetectResult,
  type EnhancementPipelineHandle,
} from 'react-native-sherpa-onnx/enhancement';
import type {
  StreamingPipelineHandle,
  StreamingPipelineStatus,
} from 'react-native-sherpa-onnx/audiobuffer';
```

- **`EnhancementModelType`:** `'gtcrn' | 'dpdfnet'`
- **`EnhancementDetectResult`:** shared detection base (`success`, `error`, `detectedModels`, `modelType`, optional `languages`, `quantization`, `detectionSources`)

Offline **`createEnhancement`** / **`EnhancementEngine`** are documented in [enhancement-offline.md](enhancement-offline.md#api-reference).

---

## Platform notes

- **Android:** `OnlineSpeechDenoiser` (sherpa-onnx Kotlin API).
- **iOS:** C++ wrapper + sherpa-onnx cxx API (`SherpaOnnx+Enhancement.mm`, `enhancement/sherpa-onnx-enhancement-wrapper.*`).

---

## Error codes

Typical **promise rejection `code`** strings from the native layer (offline + streaming). Message text varies; use **`code`** for branching when catching.

| Error code | Explanation |
| --- | --- |
| `DETECT_ERROR` | Model detection failed or returned no usable result. |
| `ENHANCEMENT_INIT_ERROR` | Offline engine initialization failed (e.g. invalid model path/type or native init failure). |
| `ENHANCEMENT_ERROR` | Generic offline enhancement runtime failure. |
| `ENHANCEMENT_BUFFER_NOT_FOUND` | Referenced audio buffer id was not found (missing or already released). |
| `ENHANCEMENT_BUFFER_KIND_MISMATCH` | Buffer kind does not match expected offline/streaming input contract. |
| `ENHANCEMENT_BUFFER_EMPTY` | Input offline buffer contains no samples. |
| `ENHANCEMENT_OUTPUT_NOT_EMPTY` | Offline output buffer must be empty before `enhance(...)`. |
| `OFFLINE_OOM` | Not enough memory for offline enhancement paths. Prefer streaming enhancement for large inputs, or chunk offline work with the segmentation engine ([segmentation-engine.md](./segmentation-engine.md)). Native reject text references the same doc path. |
| `ONLINE_ENHANCEMENT_INIT_ERROR` | Streaming engine initialization failed (missing ids, detection/init failure, invalid setup). |
| `ONLINE_ENHANCEMENT_ERROR` | Streaming runtime failure (e.g. missing online instance, unload conflict with active pipeline). |
| `PIPELINE_NOT_FOUND` | Pipeline id is not registered (already stopped or never started). |
| `PIPELINE_FLUSH_ERROR` | `flush()` failed for the running pipeline. |
| `PIPELINE_RESET_ERROR` | `reset()` failed for the running pipeline. |

---

## See also

- [Speech enhancement (offline)](enhancement-offline.md)
- [Speech enhancement (offline)](enhancement-offline.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md) · [offline](audiobuffer-offline.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)

## Use case examples

<details>
<summary>Real-time denoise and feed output into downstream STT</summary>

```ts
import { createStreamingEnhancement } from 'react-native-sherpa-onnx/enhancement';
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import { createEmptyLiveAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { createLiveTextBuffer, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';

const denoiser = await createStreamingEnhancement({ modelSource: { kind: 'app', base: 'files', path: 'models/enhancement' }, modelType: 'auto' });
const stt = await createStreamingSTT({ modelSource: { kind: 'app', base: 'files', path: 'models/streaming-stt' }, modelType: 'auto' });

const sr = await denoiser.getSampleRate();
const noisyIn = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });
const cleanOut = await createEmptyLiveAudioBuffer({ sampleRate: sr, channelCount: 1 });
const textOut = await createLiveTextBuffer({ maxSegments: 2048 });

const enhPipeline = await denoiser.enhance(noisyIn.bufferId, cleanOut.bufferId);
const sttPipeline = await stt.transcribe(cleanOut, textOut, { chunkSize: 3200 });

// ... feed mic frames into noisyIn ...

await enhPipeline.flush();
await sttPipeline.flush();
await enhPipeline.stop();
await sttPipeline.stop();

await stt.destroy();
await denoiser.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(cleanOut);
await releasePipelineAudioBuffer(noisyIn);
```

</details>

<details>
<summary>Enable segmented streaming checkpoints for long sessions</summary>

```ts
const pipeline = await denoiser.enhance(inputBuf.bufferId, outputBuf.bufferId, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'continuous_frames', checkpointIntervalMs: 1000 },
  },
});

const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

</details>

