# Speech enhancement API

On-device speech denoising (**GTCRN**, **DPDFNet**) with:

- **Offline (batch):** `OfflineAudioBuffer` → `OfflineAudioBuffer` — input populated, output empty at model rate.
- **Online (streaming):** chunk-based API for low-latency paths (unchanged in this chapter).
- **Live pipeline:** `LiveAudioBuffer` → `LiveAudioBuffer` — native background thread reads from input, denoises, writes to output. Zero JS bridging overhead.

**Import path (facade):** `react-native-sherpa-onnx/enhancement`

For **offline STT / TTS / alignment** composition with pipeline buffers, see [stt-offline.md](stt-offline.md), [tts-offline.md](tts-offline.md), and [alignment.md](alignment.md).

---

## Models and paths

- **`ModelPathConfig`:** `{ type: 'asset' | 'file' | 'auto', path: string }` (from `react-native-sherpa-onnx`, same as STT/TTS).
- In-app downloads: [download-manager.md](download-manager.md) with category **`ModelCategory.Enhancement`** (when exposed in your app catalog).
- Model detection without loading the denoiser: **`detectEnhancementModel(...)`**.
- File expectations per family: [model-setup.md](model-setup.md) where applicable.

---

## Model detection

`detectEnhancementModel` does **not** load the denoiser — use it as a **pre-check** before **`createEnhancement`** (same idea as `detectTtsModel` / `detectSttModel`).

**Rules (directory scan):**

- Recursively finds `.onnx` under the resolved model directory (depth 4, same family as other detectors).
- Filename / path contains `gtcrn` → candidate **`gtcrn`**; contains `dpdfnet` or `dpcrn` → candidate **`dpdfnet`**.
- **`modelType: 'auto'`** (default): prefers **`gtcrn`** if both ONNX stacks are present, else **`dpdfnet`**.
- **`assetName`:** optional. If omitted, native catalog hints use the **last segment** of `modelPath.path` (with common archive suffixes stripped). If set, that string wins for **`languages`** / **`quantization`** when both directory and asset id are passed to native.

**`detectionSources`:** optional ordered trace (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`). **`nameOnly`** means no file list was scanned — see native `error` when `success` is false.

---

## Quick start (offline)

Offline enhancement uses **`OfflineAudioBuffer`** handles for both input and output. The input buffer is populated (from a file, samples, or live snapshot); the output buffer is created empty at the denoiser's sample rate.

```ts
import {
  createEnhancement,
  detectEnhancementModel,
} from 'react-native-sherpa-onnx/enhancement';
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  saveOfflineAudioBufferToWav,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const modelPath = { type: 'file' as const, path: '/absolute/path/to/enhancement-model-dir' };

const det = await detectEnhancementModel(modelPath, { modelType: 'auto' });
if (!det.success) throw new Error(det.error ?? 'Enhancement detection failed');

const enhancement = await createEnhancement({
  modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  numThreads: 2,
  provider: 'cpu',
  debug: false,
});

try {
  const audioIn = await createOfflineAudioBufferFromFile('/absolute/path/input.wav');
  const sr = await enhancement.getSampleRate();
  const audioOut = await createEmptyOfflineAudioBuffer(sr);

  await enhancement.enhance(audioIn, audioOut);

  // Save denoised audio to WAV
  await saveOfflineAudioBufferToWav(audioOut.bufferId, '/absolute/path/out.wav');

  // Release buffers
  await releasePipelineAudioBuffer(audioIn.bufferId);
  await releasePipelineAudioBuffer(audioOut.bufferId);
} finally {
  await enhancement.destroy();
}
```

Typical composition:

```text
File / mic → OfflineAudioBuffer₁ → [Offline Enhancement] → OfflineAudioBuffer₂ → STT / Alignment / export
```

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
| **Offline engine** | Created with **`createEnhancement`**. Holds native **`OfflineSpeechDenoiser`**. Call **`destroy()`** when done. |
| **`OfflineAudioBuffer` (input)** | Populated buffer from file, samples, or live snapshot. Read-only during enhancement. |
| **`OfflineAudioBuffer` (output)** | Empty buffer created at the denoiser's sample rate. Filled exactly once by **`enhance()`**. Inspect via **`getPipelineAudioBufferInfo()`**, save via **`saveOfflineAudioBufferToWav()`**. |
| **`EnhancedAudio`** | `{ samples: Float32Array; sampleRate: number }` returned by streaming **`feedSamples`** / **`flush`**. Only used in the streaming API. |
| **Streaming engine** | **`createStreamingEnhancement`**. **`reset`** clears internal state; **`destroy`** releases native **`OnlineSpeechDenoiser`**. |
| **Live engine** | **`createLiveEnhancement`**. Extends streaming engine with **`enhance(in, out)`** that starts a native pipeline thread. The pipeline auto-stops when the input buffer finalizes. |
| **Pipeline handle** | Returned by **`enhance()`**. **`stop()`** / **`flush()`** / **`reset()`** / **`getStatus()`**. Registered in a generic **`StreamingPipelineRegistry`**. |

---

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional **`provider`** on init; see [execution-providers.md](execution-providers.md) |
| Input format (offline) | Any format supported by **`createOfflineAudioBufferFromFile()`** (WAV, etc.) |
| Instance lifetime | Always **`destroy()`** offline and streaming instances; **`releasePipelineAudioBuffer()`** on created buffers |

---

## API reference

Signatures below are exported from **`react-native-sherpa-onnx/enhancement`** unless noted. Types live in **`src/enhancement/types.ts`** and **`src/enhancement/streamingTypes.ts`**.

### `detectEnhancementModel(modelPath, options?)`

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

---

### `createEnhancement(options)`

```ts
function createEnhancement(
  options: EnhancementInitializeOptions
): Promise<EnhancementEngine>;
```

```ts
const enhancement = await createEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
  debug: false,
});
```

---

### Offline engine (`EnhancementEngine`)

#### `enhancement.enhance(audioIn, audioOut)`

```ts
enhance(
  audioIn: OfflineAudioBufferIdSource,
  audioOut: OfflineAudioBufferIdSource
): Promise<void>;
```

```ts
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const audioIn = await createOfflineAudioBufferFromFile('/tmp/noisy.wav');
const sr = await enhancement.getSampleRate();
const audioOut = await createEmptyOfflineAudioBuffer(sr);

await enhancement.enhance(audioIn, audioOut);
```

- **`audioIn`:** populated **`OfflineAudioBuffer`** (file-backed or RAM); must be **mono** at a rate the denoiser accepts.
- **`audioOut`:** **empty** offline buffer with **`sampleRate`** matching the denoiser's rate (from **`getSampleRate()`**).
- **Returns:** `Promise<void>`. Inspect result via **`getPipelineAudioBufferInfo(audioOut)`** or save via **`saveOfflineAudioBufferToWav()`**.

---

#### `enhancement.getSampleRate()`

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await enhancement.getSampleRate();
console.log('Denoiser sample rate', sr);
```

---

#### `enhancement.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await enhancement.destroy();
```

---

### Online engine (`OnlineEnhancementEngine`)

### `createStreamingEnhancement(options)`

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

---

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

---

### `createLiveEnhancement(options)`

```ts
function createLiveEnhancement(
  options: StreamingEnhancementInitializeOptions
): Promise<LiveEnhancementEngine>;
```

Returns a **`LiveEnhancementEngine`** that extends `OnlineEnhancementEngine` with a native live pipeline capability. You can still call `feedSamples`/`flush`/`reset` manually, **or** use `enhance()` to let the native side handle the audio flow.

---

### Live engine (`LiveEnhancementEngine`)

#### `engine.enhance(inputBufferId, outputBufferId)`

```ts
enhance(inputBufferId: string, outputBufferId: string): Promise<StreamingPipelineHandle>;
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

### Pipeline handle (`StreamingPipelineHandle`)

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
  samplesRead: number;
  samplesWritten: number;
  error: string | null;
}
```

---

## Types and constants

```ts
import {
  ENHANCEMENT_MODEL_TYPES,
  type EnhancementModelType,
  type EnhancementInitializeOptions,
  type EnhancementEngine,
  type EnhancementDetectResult,
  type EnhancedAudio,
  type OnlineEnhancementEngine,
  type LiveEnhancementEngine,
  type StreamingEnhancementInitializeOptions,
  type StreamingPipelineHandle,
  type StreamingPipelineStatus,
} from 'react-native-sherpa-onnx/enhancement';
```

- **`EnhancementModelType`:** `'gtcrn' | 'dpdfnet'`
- **`EnhancementDetectResult`:** shared detection base (`success`, `error`, `detectedModels`, `modelType`, optional `languages`, `quantization`, `detectionSources`)
- **`EnhancedAudio`:** `{ samples: Float32Array; sampleRate: number }` — used by streaming API (`feedSamples`, `flush`)

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

- **Android:** `OfflineSpeechDenoiser` / `OnlineSpeechDenoiser` (sherpa-onnx Kotlin API).
- **iOS:** C++ wrapper + sherpa-onnx cxx API (`SherpaOnnx+Enhancement.mm`, `enhancement/sherpa-onnx-enhancement-wrapper.*`).

---

## See also

- [STT offline (buffer patterns)](stt-offline.md)
- [TTS offline](tts-offline.md)
- [Pipeline audio buffers (`audiobuffer`)](audiobuffer.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)
