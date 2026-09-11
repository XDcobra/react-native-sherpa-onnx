# Source separation (offline)

**Status:** Android ✅ · iOS ✅ · Example app ✅

## Introduction

On-device **batch** source separation (vocals vs accompaniment) with a **pipeline-first** API. Supported model families: **Spleeter** and **UVR**. Stem order: `[0]=vocals`, `[1]=accompaniment` (UVR: non-vocals). Constants: `SEPARATION_STEM_LABELS`. For live overload (same offline weights on live buffers), see [separation-live.md](separation-live.md).

Import path: **`react-native-sherpa-onnx/separation`**.

**MVP output format:** Multi-channel stems from the native engine are **downmixed to mono** when written into each output buffer. Stereo/multi-channel output buffers are planned for a later release.

**Segmentation:** `segmentation.mode: 'off'` (default) runs one batch pass; `'auto'` splits input via the [segmentation engine](segmentation-engine.md) and separates each chunk (recommended for long mixes to reduce OOM risk). `'manual'` is not supported offline.

For **offline STT / enhancement** composition with pipeline buffers, see [stt-offline.md](stt-offline.md) and [enhancement-offline.md](enhancement-offline.md).

Create output buffers at the model rate from **`getSampleRate()`** (often `44100` for UVR/Spleeter packs).

## Quick start

All buffer parameters accept refs directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT` or `SEPARATION_INVALID_ARGUMENT`.

```ts
import {
  createSeparation,
  detectSeparationModel,
} from 'react-native-sherpa-onnx/separation';
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const modelPath = { kind: 'fs', path: '/absolute/path/to/separation-model-dir' };

const det = await detectSeparationModel(modelPath, { modelType: 'auto' });
if (!det.success) throw new Error(det.error ?? 'Separation detection failed');

const sep = await createSeparation({
  modelSource: modelPath,
  modelType: (det.modelType as 'spleeter' | 'uvr') ?? 'auto',
  numThreads: 2,
  provider: 'cpu',
});

try {
  const mixed = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/absolute/path/mix.wav',
  });
  const sr = await sep.getSampleRate();
  const numStems = await sep.getNumStems(); // typically 2
  const [vocalsOut, accompOut] = Array.from({ length: numStems }, () =>
    createEmptyOfflineAudioBuffer(sr)
  );

  const result = await sep.separate(mixed, [vocalsOut, accompOut]);
  console.log(result.status, result.processingTimeMs); // 'complete'

  await saveAudioAsFile(vocalsOut, { kind: 'fs', path: '/absolute/path/vocals.wav' }, 'wav');
  await saveAudioAsFile(accompOut, { kind: 'fs', path: '/absolute/path/accompaniment.wav' }, 'wav');

  await releasePipelineAudioBuffer(mixed);
  await releasePipelineAudioBuffer(vocalsOut);
  await releasePipelineAudioBuffer(accompOut);
} finally {
  await sep.destroy();
}
```

---

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Mono mixed PCM (file-backed or in-memory) |
| **Audio out × N** | [`OfflineAudioBuffer`](audiobuffer-offline.md) × N | N empty buffers at `getSampleRate()`; MVP writes **mono-downmixed** stems |
| **Engine** | `SeparationEngine` via `createSeparation` | `separate`, `getSampleRate`, `getNumStems`, `destroy` |

## Segmentation (Optional)

Offline batch separation can exceed mobile memory on long mixes (**OOM**). Auto mode splits input audio into bounded chunks, separates all N stems per chunk in sync, and assembles each stem output in order — lower peak RAM with a small quality tradeoff at segment boundaries.

**Modes:** `'off'` (default — one full pass) | `'auto'` (policy-driven chunks). `'manual'` is not supported.

| Evaluator | Supported | Notes |
| --- | --- | --- |
| `speech_energy_silence` | ✅ **Default** | Energy / silence cuts; set `maxSegmentMs` as hard cap for mixed music |
| `speech_vad_model` | ✅ | Model-based speech cuts; pass VAD pack via policy `modelPath` |
| Text evaluators | ❌ | Audio-domain separation does not use text policies |

```ts
const result = await sep.separate(mixed, [vocalsOut, accompOut], {
  segmentation: { mode: 'auto' },
  errorRecovery: 'skip',
  maxRetriesPerSegment: 2,
});
```

Full policy reference: [segmentation-engine.md](segmentation-engine.md). Live path: [separation-live.md](separation-live.md#segmentation-mandatory).

## API reference

### `detectSeparationModel(source, options?)`

Inspects a model directory or asset pack for Spleeter vs UVR layout **without** loading the separation engine or running inference. Always offline — `isStreaming` is `false`. For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native detection runs.

```ts
function detectSeparationModel(
  source: FileSource,
  options?: {
    modelType?: SeparationModelType | 'auto';
    assetName?: string;
  }
): Promise<SeparationDetectResult>;
```

```ts
const det = await detectSeparationModel(
  { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-spleeter-2stems' },
  { modelType: 'auto' }
);
console.log(det.success, det.modelType, det.paths?.vocals, det.paths?.accompaniment);
```

### `createSeparation(options)`

Creates an instance-scoped offline separation engine and loads the native `OfflineSourceSeparation` model. Throws if native initialization fails (`Separation initialization failed: …`). Each engine gets a unique `instanceId`; call **`destroy()`** when done.

```ts
function createSeparation(
  options: SeparationInitializeOptions
): Promise<SeparationEngine>;
```

```ts
const sep = await createSeparation({
  modelSource: { kind: 'fs', path: '/absolute/path/to/uvr-model-dir' },
  modelType: 'auto',
  numThreads: 2,
  debug: false,
});
```

### `sep.separate(audioIn, audioOuts, options?)`

Runs batch source separation: reads mono PCM from **`audioIn`**, writes one mono-downmixed stem into each empty output buffer. `audioOuts.length` must equal **`getNumStems()`** (typically `2`); all outputs must be empty `off_*` buffers.

```ts
separate(
  audioIn: OfflineAudioBufferIdSource,
  audioOuts: readonly OfflineAudioBufferIdSource[],
  options?: SeparateOptions
): Promise<SeparationResult>;
```

```ts
const result = await sep.separate(mixed, [vocals, accomp]);
// result.status === 'complete', result.totalSegments === 1 (mode 'off')
```

Live overload signature (`Live` → `SeparationPipelineHandle`): [separation-live.md](separation-live.md).

### `sep.getSampleRate()`

Returns the native engine's output sample rate (Hz) for creating empty output buffers.

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await sep.getSampleRate();
const out = createEmptyOfflineAudioBuffer(sr);
```

### `sep.getNumStems()`

Returns how many stem output buffers **`separate()`** expects (typically `2`: vocals + accompaniment).

```ts
getNumStems(): Promise<number>;
```

```ts
const n = await sep.getNumStems();
```

### `sep.destroy()`

Releases the native separation instance and unloads model weights from memory.

```ts
destroy(): Promise<void>;
```

```ts
await sep.destroy();
```

## Models and required files

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `spleeter` | `vocals` + `accompaniment` ONNX paths | `vocals`, `accompaniment` |
| `uvr` | single `model` ONNX path | `model` |

Auto mode detects the layout from directory contents and filename heuristics.

- **`FileSource`** — [model-setup.md](model-setup.md)
- **Detection & init** — [model-detect.md](model-detect.md)
- Downloads: [download-manager.md](download-manager.md) · `ModelCategory.Separation`

## Custom initialization (`initMode: 'custom'`)

Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom).

| `modelType` | Custom-init keys |
| --- | --- |
| `spleeter` | `vocals`, `accompaniment` |
| `uvr` | `model` |

```ts
import { createSeparation } from 'react-native-sherpa-onnx/separation';

const sep = await createSeparation({
  initMode: 'custom',
  modelType: 'uvr',
  customConfig: {
    model: { kind: 'fs', path: '/data/models/UVR-MDX-NET-Inst_1.onnx' },
  },
});
```

## JS Events

| Callback | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onProgress` | `OrchestrationProgress` | start of each offline segment step | segmented only (`mode: 'auto'`); single-pass (`mode: 'off'`): none |

Shapes: [Types](#types).

```ts
const result = await sep.separate(mixed, [vocalsOut, accompOut], {
  segmentation: { mode: 'auto' },
  onProgress: (p) => console.log(`${p.completedSegments}/${p.totalSegments}`),
});
```

Live overload uses `onSegment` only (no offline `onProgress`) — see [separation-live.md](separation-live.md#js-events).

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| File decode path | `OfflineAudioBuffer` (`off_*`) | Mixed track via `createOfflineAudioBufferFromFile(...)`. |
| Sample ingestion path | `OfflineAudioBuffer` (`off_*`) | App-owned PCM via `createOfflineAudioBufferFromSamples(...)`. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Isolated vocals | `OfflineAudioBuffer` (`off_*`) | Stem `[0]` from `separate(...)`. |
| Isolated accompaniment | `OfflineAudioBuffer` (`off_*`) | Stem `[1]` from `separate(...)`. |
| Offline STT on vocals | `OfflineAudioBuffer` (`off_*`) | Common separate-then-transcribe workflow. |
| File export | `saveAudioAsFile(...)` | One WAV per stem. |

```mermaid
flowchart LR
  A[OfflineAudioBuffer mix] --> B[createSeparation().separate]
  B --> C[OfflineAudioBuffer vocals]
  B --> D[OfflineAudioBuffer accompaniment]
  C --> E[Offline STT or saveAudioAsFile]
  D --> F[saveAudioAsFile]
```

## Types

### Core separation types (`react-native-sherpa-onnx/separation`)

| Type | Description |
| --- | --- |
| `SeparationModelType` | `'spleeter' \| 'uvr'` |
| `SEPARATION_MODEL_TYPES` | Readonly runtime list of model types |
| `SeparationConcreteModelType` | Alias of `SeparationModelType` (non-`auto`) |
| `SeparationDetectResult` | Return of `detectSeparationModel()` |
| `SeparationInitializeOptions` | Auto or custom init union for `createSeparation` |
| `SeparationInitOptionsShared` | Shared fields: `numThreads?`, `provider?`, `debug?` |
| `SeparateOptions` | Optional segmentation, `errorRecovery`, `maxRetriesPerSegment`, `onProgress`, `overlapSamples` |
| `SeparateSegmentationConfig` | `{ mode?: 'off' \| 'auto'; policy?: SegmentationPolicy }` |
| `SeparationResult` | `{ status, totalSegments, completedSegments, skippedSegments, failedSegment?, processingTimeMs }` |
| `SeparationStemIndex` | `0 \| 1` |
| `SEPARATION_STEM_LABELS` | `['vocals', 'accompaniment']` — index labels for the two-stem MVP |
| `SeparationEngine` | `separate` (offline / live), `getSampleRate`, `getNumStems`, `destroy` |
| `SeparationEngineInfo` | `{ instanceId, modelType, sampleRate, numStems }` |
| `SeparationErrorCode` | Error code object |
| `OrchestrationProgress` | Shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …) |

Live-only types (`SeparationLivePipelineOptions`, `SeparationPipelineHandle`): [separation-live.md](separation-live.md#types).

### Related buffer types

| Type | Description |
| --- | --- |
| `OfflineAudioBufferIdSource` | Offline audio ref or handle passed to `separate` |

See [audiobuffer-offline.md](audiobuffer-offline.md).

---

## Error codes

| Error code | Explanation |
| --- | --- |
| `DETECT_ERROR` | Model detection failed or returned no usable result. |
| `SEPARATION_INIT_ERROR` | Engine initialization failed (invalid model path/type or native init failure). |
| `SEPARATION_ERROR` | Generic runtime failure during separation or instance handling. |
| `SEPARATION_BUFFER_NOT_FOUND` | Input/output audio buffer id was not found (missing or already released). |
| `SEPARATION_BUFFER_KIND_MISMATCH` | A non-offline buffer was passed to offline `separate(...)`. |
| `SEPARATION_BUFFER_EMPTY` | Input offline buffer contains no samples. |
| `SEPARATION_OUTPUT_NOT_EMPTY` | An output buffer must be empty before calling `separate(...)`. |
| `SEPARATION_STEM_COUNT_MISMATCH` | `audioOuts.length !== getNumStems()`. |
| `OFFLINE_OOM` | Not enough memory for offline separation. Prefer `segmentation.mode: 'auto'` for long inputs. See [segmentation-engine.md](./segmentation-engine.md) · [memory-and-models.md](./memory-and-models.md). |
| `SEPARATION_INVALID_ARGUMENT` | TypeScript-side validation (e.g. wrong stem count, unsupported offline segmentation mode). |

Live-overload-specific codes (`LIVE_OFFLINE_SEGMENTATION_REQUIRED`, …): [separation-live.md](separation-live.md#error-codes).

---

## See also

- [Source separation (live overload)](separation-live.md)
- [Speech enhancement (offline)](enhancement-offline.md)
- [STT offline (buffer patterns)](stt-offline.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)
- [Memory and models](memory-and-models.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
