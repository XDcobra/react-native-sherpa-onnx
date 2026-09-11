# Speech enhancement (offline)

## Introduction

On-device batch speech denoising with a **pipeline-first** API. Reads populated noisy PCM from an offline audio buffer and writes denoised output to a second buffer; for continuous mic/file streaming use the [streaming engine](enhancement-streaming.md). If the enhancement model rate is not `16000`, set the offline buffer `sampleRate` from `getSampleRate()` explicitly to the model rate.

Import path: **`react-native-sherpa-onnx/enhancement`**.

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

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Populated noisy PCM (file-backed or in-memory) |
| **Audio out** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Empty buffer at denoiser sample rate; `enhance` writes denoised PCM once |
| **Engine** | `EnhancementEngine` via `createEnhancement` | `enhance(audioIn, audioOut, options?)`, `getSampleRate`, `destroy` |

---

## Segmentation (Optional)

Long audio in one `enhance` call can exhaust device RAM. Auto mode splits the audio buffer into chunks, denoises each offline, and assembles output in order — lower peak RAM with a small quality tradeoff at boundaries.

**Modes:** `'off'` (default — whole buffer in one pass) | `'auto'` (policy-driven chunks). `'manual'` is not supported.

| Evaluator | Supported | Notes |
| --- | --- | --- |
| `speech_energy_silence` | ✅ **Default** | Silence/low-energy boundaries; natural split points |
| `continuous_frames` | ✅ | Fixed-interval checkpoints; `checkpointIntervalMs` |
| Text evaluators | ❌ | Audio-domain input only |

```ts
const result = await engine.enhance(inBuf, outBuf, {
  segmentation: { mode: 'auto' },
  // policy defaults to speech_energy_silence
  errorRecovery: 'skip',
  maxRetriesPerSegment: 2,
});
```

Full policy reference: [segmentation-engine.md](segmentation-engine.md). Memory planning: [memory-and-models.md](memory-and-models.md). Live path: [enhancement-streaming.md](enhancement-streaming.md#segmentation-optional).

---

## API reference

Signatures below are exported from **`react-native-sherpa-onnx/enhancement`**. Types live in **`src/enhancement/types.ts`**.

### `detectEnhancementModel(source, options?)`

File-based detection **without** initializing the engine. Use before `createEnhancement` to confirm pack layout and model type. Unified cross-feature detection: [model-detect.md](model-detect.md).

The result includes `isStreaming` from native enhancement detection:
- Filesystem-backed detection runs the online compatibility guard (`gtcrn`/`dpdfnet`) and sets `isStreaming` accordingly.
- Name-only detection (asset/folder heuristics without files) can return `isStreaming: true` as best effort while `success` remains `false`.

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

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
console.log(det.success, det.modelType, det.isStreaming, det.paths?.model, det.detectedModels);
```

### `createEnhancement(options)`

Creates an `EnhancementEngine`. Init modes: **`auto`** (default — `modelSource` + optional `modelType` / `quantization`) or **`custom`** (`initMode: 'custom'`, concrete `modelType`, `customConfig: { model }`). Shared tuning: `numThreads`, `provider`, `debug`.

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
});
```

### `enhancement.enhance(audioIn, audioOut, options?)`

Reads populated `audioIn`, writes denoised PCM into empty `audioOut`. Both must be `OfflineAudioBuffer` (`off_*`). `audioOut` sample rate must match the denoiser's rate (from `getSampleRate()`). Returns `EnhancementResult` with orchestration status and segment counters.

```ts
enhance(
  audioIn: OfflineAudioBufferIdSource,
  audioOut: OfflineAudioBufferIdSource,
  options?: EnhanceOptions
): Promise<EnhancementResult>;
```

```ts
const audioIn = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/tmp/noisy.wav' });
const sr = await enhancement.getSampleRate();
const audioOut = await createEmptyOfflineAudioBuffer(sr);
await enhancement.enhance(audioIn, audioOut);
```

### `enhancement.getSampleRate()`

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await enhancement.getSampleRate();
```

### `enhancement.destroy()`

Releases the native denoiser instance.

```ts
destroy(): Promise<void>;
```

```ts
await enhancement.destroy();
```

---

## Models and paths

- **`FileSource`** — [model-setup.md](model-setup.md)
- **Detection & init** — [model-detect.md](model-detect.md)
- Downloads: [download-manager.md](download-manager.md) · `ModelCategory.Enhancement`

## Validation required files

| `modelType` | Required files | Optional | Custom-init keys |
| --- | --- | --- | --- |
| `gtcrn` | `*.onnx` (filename/path contains `gtcrn`) | — | `model` |
| `dpdfnet` | `*.onnx` (contains `dpdfnet` or `dpcrn`) | — | `model` |

Auto mode prefers `gtcrn` when both ONNX stacks are present.

## Model detection

`detectEnhancementModel` is a pre-check before `createEnhancement` — no denoiser load. Unified catalog: [model-detect.md](model-detect.md).

On filesystem-backed detection, the result includes `paths.model` (resolved `.onnx` file) when native file listing finds one. Name-only heuristics may omit `paths`.

Filename rules: recursive `.onnx` scan (depth 4); `gtcrn` in path → `gtcrn`; `dpdfnet`/`dpcrn` → `dpdfnet`. Optional `assetName` for catalog hints.

## Custom initialization (`initMode: 'custom'`)

Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom).

| `modelType` | Custom-init keys |
| --- | --- |
| `gtcrn`, `dpdfnet` | `model` |

```ts
import { createEnhancement } from 'react-native-sherpa-onnx/enhancement';

const enhancement = await createEnhancement({
  initMode: 'custom',
  modelType: 'gtcrn',
  customConfig: {
    model: { kind: 'fs', path: '/data/models/gtcrn.onnx' },
  },
});
```

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

## JS Events

| Callback | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onProgress` | `OrchestrationProgress` | start of each offline segment step | segmented only (`mode: 'auto'`); single-pass: none |

Shapes: [Types](#types).

```ts
await engine.enhance(audioIn, audioOut, {
  segmentation: { mode: 'auto' },
  onProgress: (p) => console.log(p.currentSegment, p.totalSegments),
});
```

Live overload uses `onSegment` only (no offline `onProgress`) — see [Live overload](#live-overload-on-offline-enhancement-offline-weights-live-consumption).

## Types

### Core enhancement types (`react-native-sherpa-onnx/enhancement`)

| Type | Description |
| --- | --- |
| `EnhancementModelType` | `'gtcrn' \| 'dpdfnet'` |
| `ENHANCEMENT_MODEL_TYPES` | Readonly runtime list of model types |
| `EnhancementConcreteModelType` | Alias of `EnhancementModelType` (non-`auto`) |
| `EnhancementInitOptionsShared` | Shared init fields: `numThreads?`, `provider?`, `debug?` |
| `EnhancementAutoInitializeOptions` | Auto init: `modelSource`, `quantization?`, `modelType?` + shared |
| `EnhancementCustomInitializeOptions` | Custom init: `initMode: 'custom'`, concrete `modelType`, `customConfig` + shared |
| `EnhancementInitializeOptions` | Union of auto and custom init options |
| `EnhancementDetectResult` | Return of `detectEnhancementModel()` — shared detection base (`success`, `error`, `detectedModels`, `modelType`, `isStreaming`, optional `languages`, `quantization`, `detectionSources`, `paths`) |
| `EnhanceSegmentationConfig` | `{ mode?: 'off' \| 'manual' \| 'auto'; policy?: SegmentationPolicy }` |
| `EnhanceOptions` | `segmentation?`, `errorRecovery?`, `maxRetriesPerSegment?`, `retryExhaustedFallback?`, `onProgress?`, `overlapSamples?` |
| `EnhancementResult` | `{ status, totalSegments, completedSegments, skippedSegments, failedSegment?, processingTimeMs }` |
| `EnhancementLivePipelineOptions` | Live overload options — mandatory `continuous_frames` segmentation policy, optional `onSegment` |
| `EnhancementEngine` | `enhance` (offline / live overload), `getSampleRate`, `destroy`; readonly `instanceId` |
| `EnhancementCustomConfig` | Custom init path map: `{ model: FileSource }` |
| `EnhancementErrorCode` | Error code enum for enhancement operations |
| `OrchestrationProgress` | Shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …) |

Streaming types (`StreamingEnhancementEngine`, `StreamingEnhancementInitializeOptions`, `EnhancementPipelineHandle`): [enhancement-streaming.md](enhancement-streaming.md#types).

### Related buffer types

| Type | Description |
| --- | --- |
| `OfflineAudioBufferIdSource` | Offline audio ref or handle passed to `enhance` |

See [audiobuffer-offline.md](audiobuffer-offline.md).

---

## Error codes

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
