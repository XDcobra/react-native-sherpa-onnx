# Speech enhancement (offline)

## Introduction

On-device batch speech denoising with a **pipeline-first** API:

- **Input:** offline pipeline audio buffer ([`audiobuffer` — offline](audiobuffer-offline.md)) — populated noisy PCM (file-backed or in-memory).
- **Output:** offline pipeline audio buffer ([`audiobuffer` — offline](audiobuffer-offline.md)) — empty buffer at the denoiser sample rate (`createEmptyOfflineAudioBuffer`); **`enhance`** writes denoised PCM once.
- **Engine:** `createEnhancement` exposes **`enhance(audioIn, audioOut, options?)`** (plus `getSampleRate` / `destroy`). `enhance` returns an `EnhancementResult` (`status`, segment counters, timing) while denoised PCM is read from **`audioOut`**.

Import path: `react-native-sherpa-onnx/enhancement`

For **streaming** enhancement (`LiveAudioBuffer` → `LiveAudioBuffer` via **`enhance`**), see [Speech enhancement (streaming)](enhancement-streaming.md).

For **offline STT / TTS / alignment** composition with pipeline buffers, see [stt-offline.md](stt-offline.md), [tts-offline.md](tts-offline.md), and [alignment-offline.md](alignment-offline.md).

If the enhancement model rate is not `16000`, set `targetSampleRateHz` (or offline buffer `sampleRate` from `getSampleRate()`) explicitly to the model rate.

## Models and paths

- **`FileSource`:** `{ kind: 'fs' | 'app' | 'contentUri' | 'securityScoped' | 'pad', ... }` (from `react-native-sherpa-onnx`) — used by all detect functions.
- In-app downloads: [download-manager.md](download-manager.md) with category **`ModelCategory.Enhancement`** (when exposed in your app catalog).
- Model detection without loading the denoiser: **`detectEnhancementModel(...)`**.
- File expectations per family: [model-setup.md](model-setup.md) where applicable.

---

## Model detection

Unified cross-feature detection: [model-detect.md](model-detect.md). Below, enhancement-specific rules for **`detectEnhancementModel`**.

`detectEnhancementModel` does **not** load the denoiser — use it as a **pre-check** before **`createEnhancement`** (same idea as `detectTtsModel` / `detectSttModel`).

**Rules (directory scan):**

- Recursively finds `.onnx` under the resolved model directory (depth 4, same family as other detectors).
- Filename / path contains `gtcrn` → candidate **`gtcrn`**; contains `dpdfnet` or `dpcrn` → candidate **`dpdfnet`**.
- **`modelType: 'auto'`** (default): prefers **`gtcrn`** if both ONNX stacks are present, else **`dpdfnet`**.
- **`assetName`:** optional. If omitted, native catalog hints use the **last segment** of `modelSource.path` (with common archive suffixes stripped). If set, that string wins for **`languages`** / **`quantization`** when both directory and asset id are passed to native.

**`detectionSources`:** optional ordered trace (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`). **`nameOnly`** means no file list was scanned — see native `error` when `success` is false.

---

## Custom initialization (`initMode: 'custom'`)

Use custom init when the enhancement ONNX file is **not** in a detectable folder layout (non-standard name, scattered path, or detection fails but you know the family).

- Set `initMode: 'custom'` and a concrete `modelType` (`gtcrn` or `dpdfnet`, not `'auto'`).
- Pass `customConfig` with a single **`model`** {@link FileSource} pointing at the `.onnx` file.
- Validation uses native `validate-enhancement` (same `model` key for both families). See [model-detect.md — Custom path validation](model-detect.md#custom-path-validation).
- `numThreads`, `provider`, and `debug` work the same as auto mode.

```ts
import { createEnhancement } from 'react-native-sherpa-onnx/enhancement';

const enhancement = await createEnhancement({
  initMode: 'custom',
  modelType: 'gtcrn',
  customConfig: {
    model: { kind: 'fs', path: '/data/models/gtcrn.onnx' },
  },
  numThreads: 2,
});
```

DPCRN / DPDFNet example:

```ts
const enhancement = await createEnhancement({
  initMode: 'custom',
  modelType: 'dpdfnet',
  customConfig: {
    model: { kind: 'fs', path: '/data/models/dpdfnet.onnx' },
  },
});
```

---

## Quick start

All buffer parameters accept refs directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT`.

**`audioIn`** / **`audioOut`** below are the pipeline buffers from the intro (same module for both sides).

```ts
import {
  createEnhancement,
  detectEnhancementModel,
} from 'react-native-sherpa-onnx/enhancement';
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const modelPath = { kind: 'fs', path: '/absolute/path/to/enhancement-model-dir' };

const det = await detectEnhancementModel({ kind: 'fs', path: '/absolute/path/to/enhancement-model-dir' }, { modelType: 'auto' });
if (!det.success) throw new Error(det.error ?? 'Enhancement detection failed');

const enhancement = await createEnhancement({
  modelSource: modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  numThreads: 2,
  provider: 'cpu',
  debug: false,
});

try {
  const audioIn = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/absolute/path/input.wav',
  });
  const sr = await enhancement.getSampleRate();
  const audioOut = await createEmptyOfflineAudioBuffer(sr);

  await enhancement.enhance(audioIn, audioOut);

  // Save denoised audio to WAV
  await saveAudioAsFile(audioOut, { kind: 'fs', path: '/absolute/path/out.wav' }, 'wav');

  // Release buffers
  await releasePipelineAudioBuffer(audioIn);
  await releasePipelineAudioBuffer(audioOut);
} finally {
  await enhancement.destroy();
}
```

---

## Data model and lifetime

| Item | Behaviour |
| --- | --- |
| **Offline engine** | Created with **`createEnhancement`**. Holds native **`OfflineSpeechDenoiser`**. Call **`destroy()`** when done. |
| **`OfflineAudioBuffer` (input)** | Populated buffer from file, samples, or live snapshot. Read-only during enhancement. |
| **`OfflineAudioBuffer` (output)** | Empty buffer created at the denoiser's sample rate. Filled exactly once by **`enhance()`**. Inspect via **`getPipelineAudioBufferInfo()`**, persist via `saveAudioAsFile(...)`. |

---

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional **`provider`** on init; see [execution-providers.md](execution-providers.md) |
| Input format | Any format supported by **`createOfflineAudioBufferFromFile()`** (WAV, etc.) |
| Instance lifetime | Always **`destroy()`** the offline engine; **`releasePipelineAudioBuffer()`** on created buffers |

---

## API reference

Signatures below are exported from **`react-native-sherpa-onnx/enhancement`**. Types live in **`src/enhancement/types.ts`**.

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

The result includes `isStreaming` from native enhancement detection:
- Filesystem-backed detection runs the online compatibility guard (`gtcrn`/`dpdfnet`) and sets `isStreaming` accordingly.
- Name-only detection (asset/folder heuristics without files) can return `isStreaming: true` as best effort while `success` remains `false`.

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

```ts
const det = await detectEnhancementModel(
  { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-speech-enhancement-gtcrn' },
  { modelType: 'auto' }
);
console.log(det.success, det.modelType, det.isStreaming, det.detectedModels);
```

```ts
const det2 = await detectEnhancementModel(
  { kind: 'fs', path: '/data/enhancement-pack' },
  { modelType: 'auto', assetName: 'sherpa-onnx-speech-enhancement-gtcrn-int8' }
);
```

### Factory

#### `createEnhancement(options)`

```ts
function createEnhancement(
  options: EnhancementInitializeOptions
): Promise<EnhancementEngine>;
```

```ts
const enhancement = await createEnhancement({
  modelSource: { kind: 'fs', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
  debug: false,
});
```

### Offline engine (`EnhancementEngine`)

#### `enhancement.enhance(audioIn, audioOut)`

```ts
enhance(
  audioIn: OfflineAudioBufferIdSource,
  audioOut: OfflineAudioBufferIdSource,
  options?: EnhanceOptions
): Promise<EnhancementResult>;
```

```ts
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const audioIn = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/tmp/noisy.wav',
});
const sr = await enhancement.getSampleRate();
const audioOut = await createEmptyOfflineAudioBuffer(sr);

await enhancement.enhance(audioIn, audioOut);
```

- **`audioIn`:** populated **`OfflineAudioBuffer`** (file-backed or RAM); must be **mono** at a rate the denoiser accepts.
- **`audioOut`:** **empty** offline buffer with **`sampleRate`** matching the denoiser's rate (from **`getSampleRate()`**).
- **Returns:** `EnhancementResult` with orchestration status and segment counters. Read PCM via **`getPipelineAudioBufferInfo(audioOut)`** and persist with `saveAudioAsFile(...)`.

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

## Pipeline buffers (audio input + audio output)

**Audio input**

```ts
import {
  createOfflineAudioBufferFromFile,
  createOfflineAudioBufferFromSamples,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — offline](audiobuffer-offline.md) and [audiobuffer — live / streaming](audiobuffer-streaming.md).

**Audio output**

```ts
import {
  createEmptyOfflineAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
```

See [audiobuffer — offline](audiobuffer-offline.md) and [audiobuffer — live / streaming](audiobuffer-streaming.md).

## Segmentation

Enhancement models in this SDK are primarily **offline-first**. Running enhancement on very large offline buffers can exceed memory limits on mobile devices (**OOM**). Segmentation mitigates this by splitting input audio into bounded chunks, running the offline denoiser per chunk, then assembling output in order. This lowers peak RAM, with a small quality tradeoff around segment boundaries.

Supported modes for offline enhancement:

- `'off'` (default): one full pass over the input buffer.
- `'auto'`: split input by segmentation policy and process chunk by chunk.

`'manual'` is not supported for offline enhancement.

Default policy evaluator: `speech_energy_silence`.

```ts
import { createEnhancement } from 'react-native-sherpa-onnx/enhancement';
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const engine = await createEnhancement({
  modelSource: { kind: 'fs', path: '/path/to/enhancement-model' },
  modelType: 'auto',
});

const inBuf = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/long-input.wav' });
const sampleRate = await engine.getSampleRate();
const outBuf = await createEmptyOfflineAudioBuffer(sampleRate);

try {
  const result = await engine.enhance(inBuf, outBuf, {
    segmentation: { mode: 'auto' },
    errorRecovery: 'skip',
    maxRetriesPerSegment: 2,
  });
  console.log(result.status, result.completedSegments, result.totalSegments);
} finally {
  await releasePipelineAudioBuffer(inBuf);
  await releasePipelineAudioBuffer(outBuf);
  await engine.destroy();
}
```

See [segmentation-engine.md](segmentation-engine.md) for policy details and [memory-and-models.md](memory-and-models.md) for RAM planning.

## Live overload on offline enhancement (offline weights, live consumption)

> Mandatory `segmentation.policy`. Commit-only — no partials.

The offline denoiser can drive a live pipeline directly. This is useful when you want to process a live audio stream using a monolithic offline model.

> [!WARNING]
> Because offline models are designed for whole-utterance processing, using them in live contexts via segmentation can introduce audible artifacts at segment boundaries.

```ts
const denoiser = await createEnhancement({
  modelSource: { kind: 'fs', path: '/absolute/path/to/gtcrn' },
});

const handle = await denoiser.enhance(liveAudioIn, liveAudioOut, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'continuous_frames', checkpointIntervalMs: 500 },
  },
});

// handle.stop() / .flush() / .completed as usual
const completion = await handle.completed;
console.log(`Denoised ${completion.unitsRead} samples`);
```



## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| File decode path | `OfflineAudioBuffer` (`off_*`) | Typical input via `createOfflineAudioBufferFromFile(...)`. |
| Sample ingestion path | `OfflineAudioBuffer` (`off_*`) | Use `createOfflineAudioBufferFromSamples(...)` for app-owned PCM. |
| Segmented offline source | `OfflineAudioBuffer` (`off_*`) | Use `segmentation.mode: 'auto'` for large files. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Clean batch output | `OfflineAudioBuffer` (`off_*`) | `audioOut` must be empty before `enhance(...)`. |
| Offline STT | `OfflineAudioBuffer` (`off_*`) | Common denoise-before-transcribe workflow. |
| File export | `saveAudioAsFile(...)` | Persist enhanced audio for external use. |

```mermaid
flowchart LR
  A[OfflineAudioBuffer noisy] --> B[createEnhancement().enhance]
  B --> C[OfflineAudioBuffer clean]
  C --> D[Offline STT or saveAudioAsFile]
```

More end-to-end patterns: [feature-pipelines.md#enhancement-offline-patterns](feature-pipelines.md#enhancement-offline-patterns).

## Types and constants

```ts
import {
  ENHANCEMENT_MODEL_TYPES,
  type EnhancementModelType,
  type EnhancementInitializeOptions,
  type EnhancementEngine,
  type EnhancementDetectResult,
} from 'react-native-sherpa-onnx/enhancement';
```

- **`EnhancementModelType`:** `'gtcrn' | 'dpdfnet'`
- **`EnhancementDetectResult`:** shared detection base (`success`, `error`, `detectedModels`, `modelType`, optional `languages`, `quantization`, `detectionSources`)

Streaming types (**`StreamingEnhancementEngine`**, **`StreamingEnhancementInitializeOptions`**, **`EnhancementPipelineHandle`**) are documented in [enhancement-streaming.md](enhancement-streaming.md#types-and-constants).

---

## Error codes

Typical **promise rejection `code`** strings from the native layer. Message text varies; use **`code`** for branching when catching.

| Error code | Explanation |
| --- | --- |
| `DETECT_ERROR` | Model detection failed or returned no usable result. |
| `ENHANCEMENT_INIT_ERROR` | Engine initialization failed (e.g. invalid model path/type or native init failure). |
| `ENHANCEMENT_ERROR` | Generic runtime failure during enhancement or instance handling. |
| `ENHANCEMENT_BUFFER_NOT_FOUND` | Input/output audio buffer id was not found (missing or already released). |
| `ENHANCEMENT_BUFFER_KIND_MISMATCH` | A non-offline buffer was passed to offline `enhance(...)`. |
| `ENHANCEMENT_BUFFER_EMPTY` | Input offline buffer contains no samples. |
| `ENHANCEMENT_OUTPUT_NOT_EMPTY` | Output buffer must be empty before calling `enhance(...)`. |
| `OFFLINE_OOM` | Not enough memory for offline enhancement. Use streaming enhancement for large inputs, or chunk offline work with the segmentation engine ([segmentation-engine.md](./segmentation-engine.md)). Native reject text references the same doc path. |

For streaming and live-pipeline errors (`ONLINE_ENHANCEMENT_*`, `PIPELINE_*`), see [enhancement-streaming.md](enhancement-streaming.md).

---

## See also

- [Speech enhancement (streaming / live)](enhancement-streaming.md)
- [Speech enhancement (streaming)](enhancement-streaming.md)
- [STT offline (buffer patterns)](stt-offline.md)
- [TTS offline](tts-offline.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md) · [live / streaming](audiobuffer-streaming.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)

## Use case examples

<details>
<summary>Denoise a long recording with segmented offline processing</summary>

```ts
import { createEnhancement } from 'react-native-sherpa-onnx/enhancement';
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const engine = await createEnhancement({
  modelSource: { kind: 'fs', path: '/path/to/gtcrn' },
  modelType: 'gtcrn',
});

const inBuf = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/noisy-long.wav' });
const outBuf = await createEmptyOfflineAudioBuffer(await engine.getSampleRate());

try {
  await engine.enhance(inBuf, outBuf, {
    segmentation: { mode: 'auto' },
    errorRecovery: 'skip',
  });
  await saveAudioAsFile(outBuf, { kind: 'fs', path: '/path/to/clean.wav' }, 'wav');
} finally {
  await releasePipelineAudioBuffer(inBuf);
  await releasePipelineAudioBuffer(outBuf);
  await engine.destroy();
}
```

</details>

<details>
<summary>Single-pass enhancement for short clips</summary>

```ts
const engine = await createEnhancement({
  modelSource: { kind: 'fs', path: '/path/to/model' },
  modelType: 'auto',
});

const inBuf = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/short.wav' });
const outBuf = await createEmptyOfflineAudioBuffer(await engine.getSampleRate());

await engine.enhance(inBuf, outBuf, { segmentation: { mode: 'off' } });
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

