# Speech enhancement (streaming)

On-device streaming speech denoising with a **pipeline-first** API:

- **Input:** live pipeline audio buffer ([`audiobuffer` — live / streaming](audiobuffer-streaming.md)) — ring/spool buffer the denoiser **drains** (mic, append, or upstream native pipeline).
- **Output:** live pipeline audio buffer ([`audiobuffer` — live / streaming](audiobuffer-streaming.md)) — separate live buffer; native worker **appends** denoised PCM (`source: "enhancement"` on append events).
- **Engine:** `createStreamingEnhancement` exposes **`enhance(audioIn, audioOut)`** → `Promise<EnhancementPipelineHandle>` (plus `getSampleRate` / `getFrameShiftInSamples` / `destroy`). There is **no** JS API to push raw sample arrays into the online denoiser; control the running worker via **`EnhancementPipelineHandle`** (`flush`, `stop`, `reset`, `getStatus`). In this guide **`denoiser`** means the returned `StreamingEnhancementEngine` and **`pipeline`** means that handle.

Import path: `react-native-sherpa-onnx/enhancement`

For **offline batch** enhancement (`OfflineAudioBuffer` → `OfflineAudioBuffer`), see [Speech enhancement (offline)](enhancement-offline.md).

For **offline STT / TTS / alignment** composition with pipeline buffers, see [stt-offline.md](stt-offline.md), [tts-offline.md](tts-offline.md), and [alignment.md](alignment.md).

## Models and paths

- **`ModelPathConfig`:** `{ type: 'asset' | 'file' | 'auto', path: string }` (from `react-native-sherpa-onnx`, same as STT/TTS).
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
- **`assetName`:** optional. If omitted, native catalog hints use the **last segment** of `modelPath.path` (with common archive suffixes stripped). If set, that string wins for **`languages`** / **`quantization`** when both directory and asset id are passed to native.

**`detectionSources`:** optional ordered trace (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`). **`nameOnly`** means no file list was scanned — see native `error` when `success` is false.

---

## Quick start

**`inputBuf`** / **`outputBuf`** below are the **input** and **output** live pipeline buffers from the intro; PCM moves natively between them while the worker runs — no per-chunk JS bridging for steady-state audio.

```ts
import { createStreamingEnhancement } from 'react-native-sherpa-onnx/enhancement';
import {
  createLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const denoiser = await createStreamingEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/enhancement-model-dir' },
  modelType: 'auto',
});

const sr = await denoiser.getSampleRate();
const inputBuf = await createLiveAudioBuffer({ sampleRate: sr });
const outputBuf = await createLiveAudioBuffer({
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
    // e.samples is set when native emitAppendedSamples is enabled (default).
  },
});

const pipeline = await denoiser.enhance(inputBuf.bufferId, outputBuf.bufferId);

// Mic or other source feeds inputBuf; the pipeline appends to outputBuf and fires onFramesAppended.

await pipeline.stop();
outputBuf.unsubscribeEvents();
inputBuf.unsubscribeEvents();
await releasePipelineAudioBuffer(inputBuf.bufferId);
await releasePipelineAudioBuffer(outputBuf.bufferId);
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

#### `detectEnhancementModel(modelPath, options?)`

```ts
function detectEnhancementModel(
  modelPath: ModelPathConfig,
  options?: {
    modelType?: EnhancementModelType | 'auto';
    assetName?: string;
  }
): Promise<EnhancementDetectResult>;
```

```ts
const det = await detectEnhancementModel(
  { type: 'asset', path: 'models/sherpa-onnx-speech-enhancement-gtcrn' },
  { modelType: 'auto' }
);
console.log(det.success, det.modelType, det.detectedModels);
```

```ts
const det2 = await detectEnhancementModel(
  { type: 'file', path: '/data/enhancement-pack' },
  { modelType: 'auto', assetName: 'sherpa-onnx-speech-enhancement-gtcrn-int8' }
);
```

### Initialization

#### `createStreamingEnhancement(options)`

```ts
function createStreamingEnhancement(
  options: StreamingEnhancementInitializeOptions
): Promise<StreamingEnhancementEngine>;
```

```ts
const denoiser = await createStreamingEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
});
```

Creates the native online denoiser instance. Use **`denoiser.enhance`** with **`LiveAudioBuffer`** ids to run a pipeline; read PCM from the **output** buffer (not from a JS return value).

### Denoiser instance (`StreamingEnhancementEngine`)

#### `denoiser.enhance(inputBufferId, outputBufferId)`

```ts
enhance(
  inputBufferId: string,
  outputBufferId: string
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
  createLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — live / streaming](audiobuffer-streaming.md) and [overview](audiobuffer.md).

**Audio output**

```ts
import {
  createLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  getLiveAudioBufferSamplesSlice,
  saveLiveAudioBufferToWav,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — live / streaming](audiobuffer-streaming.md) and [overview](audiobuffer.md).

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

## Error code quick table

Typical **promise rejection `code`** strings from the native layer (offline vs online). Message text varies; use **`code`** for branching when catching.

| Code | Typical reason |
| --- | --- |
| `DETECT_ERROR` | Detection failed or returned null (Android) |
| `ENHANCEMENT_INIT_ERROR` | Missing `instanceId` / `modelDir`, detection failed, unsupported model type, native init error |
| `ENHANCEMENT_ERROR` | Instance not found, denoise run failed (generic) |
| `ENHANCEMENT_BUFFER_NOT_FOUND` | Unknown or released audio buffer id |
| `ENHANCEMENT_BUFFER_KIND_MISMATCH` | Non-offline buffer passed to offline enhance |
| `ENHANCEMENT_BUFFER_EMPTY` | Input offline buffer has no samples |
| `ENHANCEMENT_OUTPUT_NOT_EMPTY` | Output buffer must be empty (same contract as TTS `synthesize`) |
| `ONLINE_ENHANCEMENT_INIT_ERROR` | Streaming init: missing ids, detection/init failure |
| `ONLINE_ENHANCEMENT_ERROR` | Online instance not found, unload conflict with active pipeline, etc. |
| `PIPELINE_NOT_FOUND` | Pipeline id not registered (already stopped or never started) |
| `PIPELINE_FLUSH_ERROR` | Flush command failed on a running pipeline |
| `PIPELINE_RESET_ERROR` | Reset command failed on a running pipeline |

---

## Platform notes

- **Android:** `OnlineSpeechDenoiser` (sherpa-onnx Kotlin API).
- **iOS:** C++ wrapper + sherpa-onnx cxx API (`SherpaOnnx+Enhancement.mm`, `enhancement/sherpa-onnx-enhancement-wrapper.*`).

---

## See also

- [Speech enhancement (offline)](enhancement-offline.md)
- [Speech enhancement (overview)](speech-enhancement.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md) · [overview](audiobuffer.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)
