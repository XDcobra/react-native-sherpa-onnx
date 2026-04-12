# Speech enhancement (streaming / live)

On-device speech denoising (**GTCRN**, **DPDFNet**) for low-latency paths:

- **Online (streaming):** chunk-based **`feedSamples`** / **`flush`** — returns **`EnhancedAudio`** in JavaScript.
- **Live pipeline:** **`LiveAudioBuffer`** → **`LiveAudioBuffer`** — native background thread; no per-chunk JS bridging.

**Import path:** `react-native-sherpa-onnx/enhancement`

For **offline batch** enhancement (`OfflineAudioBuffer` → `OfflineAudioBuffer`), see [Speech enhancement (offline)](enhancement-offline.md).

For **offline STT / TTS / alignment** composition with pipeline buffers, see [stt-offline.md](stt-offline.md), [tts-offline.md](tts-offline.md), and [alignment.md](alignment.md).

---

## Models and paths

- **`ModelPathConfig`:** `{ type: 'asset' | 'file' | 'auto', path: string }` (from `react-native-sherpa-onnx`, same as STT/TTS).
- In-app downloads: [download-manager.md](download-manager.md) with category **`ModelCategory.Enhancement`** (when exposed in your app catalog).
- Model detection without loading the denoiser: **`detectEnhancementModel(...)`** (same rules as offline; see [Model detection](enhancement-offline.md#model-detection) on the offline page for the full rule list).
- File expectations per family: [model-setup.md](model-setup.md) where applicable.

---

## Model detection

`detectEnhancementModel` does **not** load the denoiser — use it as a **pre-check** before **`createStreamingEnhancement`** / **`createLiveEnhancement`** (same idea as `detectTtsModel` / `detectSttModel`).

**Rules (directory scan):**

- Recursively finds `.onnx` under the resolved model directory (depth 4, same family as other detectors).
- Filename / path contains `gtcrn` → candidate **`gtcrn`**; contains `dpdfnet` or `dpcrn` → candidate **`dpdfnet`**.
- **`modelType: 'auto'`** (default): prefers **`gtcrn`** if both ONNX stacks are present, else **`dpdfnet`**.
- **`assetName`:** optional. If omitted, native catalog hints use the **last segment** of `modelPath.path` (with common archive suffixes stripped). If set, that string wins for **`languages`** / **`quantization`** when both directory and asset id are passed to native.

**`detectionSources`:** optional ordered trace (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`). **`nameOnly`** means no file list was scanned — see native `error` when `success` is false.

---

## Quick start (online / streaming)

```ts
import { createStreamingEnhancement } from 'react-native-sherpa-onnx/enhancement';

const streaming = await createStreamingEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
});

try {
  const chunkOut = await streaming.feedSamples(chunk, 16000);
  const tailOut = await streaming.flush();
  console.log(chunkOut.sampleRate, tailOut.samples.length);
} finally {
  await streaming.reset().catch(() => {});
  await streaming.destroy();
}
```

See **API reference** below for `feedSamples`, `flush`, `reset`, **`getFrameShiftInSamples`**, and **`destroy`**.

---

## Quick start (live pipeline)

The live pipeline runs enhancement entirely on the native side. Audio flows from a **`LiveAudioBuffer`** (e.g. mic input) through the denoiser into a second **`LiveAudioBuffer`** — no JS bridge overhead per chunk.

```ts
import {
  createLiveEnhancement,
} from 'react-native-sherpa-onnx/enhancement';
import {
  createLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const engine = await createLiveEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/enhancement-model-dir' },
  modelType: 'auto',
});

const sr = await engine.getSampleRate();
const inputBuf = await createLiveAudioBuffer({ sampleRate: sr });
const outputBuf = await createLiveAudioBuffer({ sampleRate: sr });

// Start the native pipeline thread
const pipeline = await engine.enhance(inputBuf.bufferId, outputBuf.bufferId);

// Mic or other source feeds inputBuf via startRecording() or appendSamples().
// Enhanced audio appears automatically in outputBuf with source "enhancement".

// When done:
await pipeline.stop();
await releasePipelineAudioBuffer(inputBuf.bufferId);
await releasePipelineAudioBuffer(outputBuf.bufferId);
await engine.destroy();
```

The pipeline also supports **`flush()`** (drains internal denoiser state without stopping), **`reset()`** (clears denoiser state without stopping), and **`getStatus()`** for monitoring.

When the input buffer is **finalized** (e.g. mic stops), the pipeline automatically flushes remaining samples and exits.

---

## Data model and lifetime

| Item | Behaviour |
| --- | --- |
| **`EnhancedAudio`** | `{ samples: Float32Array; sampleRate: number }` returned by streaming **`feedSamples`** / **`flush`**. Only used in the streaming API. |
| **Streaming engine** | **`createStreamingEnhancement`**. **`reset`** clears internal state; **`destroy`** releases native **`OnlineSpeechDenoiser`**. |
| **Live engine** | **`createLiveEnhancement`**. Extends streaming engine with **`enhance(in, out)`** that starts a native pipeline thread. The pipeline auto-stops when the input buffer finalizes. |
| **Pipeline handle** | Returned by **`enhance()`** as **`EnhancementPipelineHandle`** (`extends` generic **`StreamingPipelineHandle`**, adds **`instanceId`**). **`stop()`** / **`flush()`** / **`reset()`** / **`getStatus()`**. Registered in **`StreamingPipelineRegistry`**. |

---

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional **`provider`** on init; see [execution-providers.md](execution-providers.md) |
| Chunk / live input | Float PCM at the **model sample rate**; live input buffer must match **`getSampleRate()`** |
| Instance lifetime | Always **`destroy()`** streaming engines; **`releasePipelineAudioBuffer()`** on created buffers; **`pipeline.stop()`** before tearing down live buffers |

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

### Factory

#### `createStreamingEnhancement(options)`

```ts
function createStreamingEnhancement(
  options: StreamingEnhancementInitializeOptions
): Promise<OnlineEnhancementEngine>;
```

```ts
const online = await createStreamingEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
});
```

#### `createLiveEnhancement(options)`

```ts
function createLiveEnhancement(
  options: StreamingEnhancementInitializeOptions
): Promise<LiveEnhancementEngine>;
```

Returns a **`LiveEnhancementEngine`** that extends **`OnlineEnhancementEngine`** with native **`enhance(in, out)`** live pipeline support. You can still call **`feedSamples`** / **`flush`** / **`reset`** manually, or use **`enhance()`** for buffer-driven streaming.

### Online engine (`OnlineEnhancementEngine`)

Created with **`createStreamingEnhancement`** (see [Factory](#factory)) or obtained as the streaming base of **`LiveEnhancementEngine`**.

#### `streaming.feedSamples(samples, sampleRate)`

```ts
feedSamples(samples: number[], sampleRate: number): Promise<EnhancedAudio>;
```

```ts
const out = await streaming.feedSamples(frame, 16000);
```

---

#### `streaming.flush()`

```ts
flush(): Promise<EnhancedAudio>;
```

```ts
const tail = await streaming.flush();
```

---

#### `streaming.reset()`

```ts
reset(): Promise<void>;
```

```ts
await streaming.reset();
```

---

#### `streaming.getSampleRate()`

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await streaming.getSampleRate();
```

---

#### `streaming.getFrameShiftInSamples()`

```ts
getFrameShiftInSamples(): Promise<number>;
```

```ts
const shift = await streaming.getFrameShiftInSamples();
```

---

#### `streaming.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await streaming.destroy();
```

### Live engine (`LiveEnhancementEngine`)

Created with **`createLiveEnhancement`** (see [Factory](#factory)).

#### `engine.enhance(inputBufferId, outputBufferId)`

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
const pipeline = await engine.enhance(inputBuf.bufferId, outputBuf.bufferId);
```

---

### Pipeline handle (`EnhancementPipelineHandle`)

`EnhancementPipelineHandle` extends the generic **`StreamingPipelineHandle`** (same `pipelineId`, `stop` / `flush` / `reset` / `getStatus`) and adds **`instanceId`**: the online enhancement engine that owns `startEnhancementPipeline`.

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

---

## Types and constants

```ts
import {
  ENHANCEMENT_MODEL_TYPES,
  type EnhancementModelType,
  type EnhancedAudio,
  type OnlineEnhancementEngine,
  type LiveEnhancementEngine,
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
- **`EnhancedAudio`:** `{ samples: Float32Array; sampleRate: number }` — used by streaming API (`feedSamples`, `flush`)

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
| `ONLINE_ENHANCEMENT_ERROR` | Streaming: instance not found, feed/flush/reset failure |
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
- [Pipeline audio buffers (`audiobuffer`)](audiobuffer.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)
