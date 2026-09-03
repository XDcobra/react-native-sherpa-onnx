# Source separation (offline)

**Status:** Android ✅ · iOS ✅ · Example app ✅

## Introduction

On-device **batch** source separation (vocals vs accompaniment) with a **pipeline-first** API. Supported model families: **Spleeter** and **UVR**.

For **live overload** (same offline weights on live buffers — not a true streaming model), see [Source separation (live overload)](separation-streaming.md). Shared pipeline-handle lifecycle: [streaming-pipelines-overview.md](streaming-pipelines-overview.md).

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Mono mixed PCM (file-backed or in-memory) |
| **Output** | [`OfflineAudioBuffer`](audiobuffer-offline.md) × N | N empty buffers at separation sample rate; MVP writes **mono-downmixed** stems |
| **Engine** | `SeparationEngine` via `createSeparation` | `separate(Offline, Offline[], options?)` → `SeparationResult`. Also `getSampleRate`, `getNumStems`, `destroy` |

Import path: `react-native-sherpa-onnx/separation`

**Stem order** (sherpa-onnx convention): `[0]=vocals`, `[1]=accompaniment` (UVR: non-vocals). Constants: `SEPARATION_STEM_LABELS`.

**MVP output format:** Multi-channel stems from the native engine are **downmixed to mono** when written into each output buffer. Stereo/multi-channel output buffers are planned for a later release.

**Segmentation:** `segmentation.mode: 'off'` (default) runs one batch pass; `'auto'` splits input via the [segmentation engine](segmentation-engine.md) and separates each chunk (recommended for long mixes to reduce OOM risk). `'manual'` is not supported offline.

For **offline STT / enhancement** composition with pipeline buffers, see [stt-offline.md](stt-offline.md) and [enhancement-offline.md](enhancement-offline.md).

Create output buffers at the model rate from **`getSampleRate()`** (often `44100` for UVR/Spleeter packs).

## Quick start

All buffer parameters accept refs directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT` or `SEPARATION_INVALID_ARGUMENT`.

**`audioIn`** / **`audioOuts`** below are pipeline buffers from the intro table.

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

## API reference

Signatures below are exported from **`react-native-sherpa-onnx/separation`**. Types live in **`src/separation/types.ts`**.

### Detection

#### `detectSeparationModel(source, options?)`

Inspects a model directory or asset pack for Spleeter vs UVR layout **without** loading the separation engine or running inference.

```ts
function detectSeparationModel(
  source: FileSource,
  options?: {
    modelType?: SeparationModelType | 'auto';
    assetName?: string;
  }
): Promise<SeparationDetectResult>;
```

Always offline — `isStreaming` is `false`. For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native detection runs.

```ts
const det = await detectSeparationModel(
  { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-spleeter-2stems' },
  { modelType: 'auto' }
);
console.log(det.success, det.modelType, det.paths?.vocals, det.paths?.accompaniment);
```

### Factory

#### `createSeparation(options)`

Creates an instance-scoped offline separation engine and loads the native `OfflineSourceSeparation` model.

```ts
function createSeparation(
  options: SeparationInitializeOptions
): Promise<SeparationEngine>;
```

Throws if native initialization fails (`Separation initialization failed: …`). Each engine gets a unique `instanceId`; call **`destroy()`** when done.

```ts
const sep = await createSeparation({
  modelSource: { kind: 'fs', path: '/absolute/path/to/uvr-model-dir' },
  modelType: 'auto',
  numThreads: 2,
  debug: false,
});
```

### Offline engine (`SeparationEngine`)

#### `sep.separate(audioIn, audioOuts, options?)`

Runs batch source separation: reads mono PCM from **`audioIn`**, writes one mono-downmixed stem into each empty output buffer.

```ts
separate(
  audioIn: OfflineAudioBufferIdSource,
  audioOuts: readonly OfflineAudioBufferIdSource[],
  options?: SeparateOptions
): Promise<SeparationResult>;
```

**Constraints:** `audioOuts.length` must equal **`getNumStems()`** (typically `2`); all outputs must be empty `off_*` buffers.

Live overload signature (`Live` → `SeparationPipelineHandle`): [separation-streaming.md](separation-streaming.md).

```ts
const mixed = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/tmp/mix.wav' });
const sr = await sep.getSampleRate();
const vocals = createEmptyOfflineAudioBuffer(sr);
const accomp = createEmptyOfflineAudioBuffer(sr);

const result = await sep.separate(mixed, [vocals, accomp]);
// result.status === 'complete', result.totalSegments === 1 (mode 'off')
// vocals / accomp: mono stems at sr
```

- **`audioIn`:** populated **`OfflineAudioBuffer`** (`off_*`); mono mixed audio.
- **`audioOuts`:** N **empty** offline buffers at the separation sample rate (`getSampleRate()`).
- **Returns:** `SeparationResult` with orchestration counters (`totalSegments`, `completedSegments`, `skippedSegments`, optional `failedSegment`, `processingTimeMs`). With `segmentation.mode: 'off'`, `totalSegments` is `1`. Read PCM via **`getPipelineAudioBufferInfo()`** and persist with `saveAudioAsFile(...)`.

---

#### `sep.getSampleRate()`

Returns the native engine's output sample rate (Hz) for creating empty output buffers.

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await sep.getSampleRate();
const out = createEmptyOfflineAudioBuffer(sr);
```

---

#### `sep.getNumStems()`

Returns how many stem output buffers **`separate()`** expects (typically `2`: vocals + accompaniment).

```ts
getNumStems(): Promise<number>;
```

```ts
const n = await sep.getNumStems();
const sr = await sep.getSampleRate();
const outs = Array.from({ length: n }, () => createEmptyOfflineAudioBuffer(sr));
```

---

#### `sep.destroy()`

Releases the native separation instance and unloads model weights from memory.

```ts
destroy(): Promise<void>;
```

```ts
await sep.destroy();
// Further calls on this engine throw: "has been destroyed"
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

See [audiobuffer — offline](audiobuffer-offline.md).

**Audio output (N stems)**

```ts
import {
  createEmptyOfflineAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
```

Create **one empty buffer per stem** at `getSampleRate()`. Stem index `0` is vocals, `1` is accompaniment (`SEPARATION_STEM_LABELS`).

### Buffer data model and lifetime

| Item | Behaviour |
| --- | --- |
| **Offline engine** | Created with **`createSeparation`**. Holds native **`OfflineSourceSeparation`**. Call **`destroy()`** when done. |
| **`OfflineAudioBuffer` (input)** | Populated buffer from file or samples. Read-only during separation. |
| **`OfflineAudioBuffer` (outputs)** | N empty buffers at separation sample rate. Each filled exactly once by **`separate()`**. MVP stores mono-downmixed PCM per stem. |

## Models and paths

- **`FileSource`** — [model-setup.md](model-setup.md)
- **Detection & init** — [model-detect.md](model-detect.md)
- Downloads: [download-manager.md](download-manager.md) · `ModelCategory.Separation`

## Validation required files

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `spleeter` | `vocals` + `accompaniment` ONNX paths | `vocals`, `accompaniment` |
| `uvr` | single `model` ONNX path | `model` |

Auto mode detects the layout from directory contents and filename heuristics.

## Model detection

`detectSeparationModel` is a pre-check before `createSeparation` — no separation engine load. Unified catalog: [model-detect.md](model-detect.md).

On filesystem-backed detection, the result includes resolved paths when native file listing finds them:

- **Spleeter:** `paths.vocals`, `paths.accompaniment`
- **UVR:** `paths.model`

Optional `assetName` disambiguates catalog hints when multiple ONNX files are present.

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

## Segmentation

Offline batch separation can exceed mobile memory on long mixes (**OOM**). Segment-wise orchestration splits input audio into bounded chunks, runs **`separateOfflineAudioBuffers`** per chunk for **all N stems in sync**, then assembles each stem output in order — same pattern as [enhancement-offline.md — Segmentation](enhancement-offline.md#segmentation).

Supported modes:

- `'off'` (default): one full pass over the input buffer.
- `'auto'`: split input by segmentation policy and process chunk by chunk.

`'manual'` is not supported for offline separation.

Default policy evaluator: `speech_energy_silence`. Mixed music may not have clear speech pauses — set **`maxSegmentMs`** in the policy as a hard cap on chunk length (primary OOM lever). Optional **`speech_vad_model`** if VAD-based cuts fit your content better.

```ts
import { createSeparation } from 'react-native-sherpa-onnx/separation';
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const sep = await createSeparation({
  modelSource: { kind: 'fs', path: '/path/to/uvr-model' },
  modelType: 'auto',
});

const mixed = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/long-mix.wav',
});
const sr = await sep.getSampleRate();
const vocalsOut = createEmptyOfflineAudioBuffer(sr);
const accompOut = createEmptyOfflineAudioBuffer(sr);

try {
  const result = await sep.separate(mixed, [vocalsOut, accompOut], {
    segmentation: { mode: 'auto' },
    errorRecovery: 'skip',
    maxRetriesPerSegment: 2,
  });
  console.log(result.status, result.completedSegments, result.totalSegments);
} finally {
  await releasePipelineAudioBuffer(mixed);
  await releasePipelineAudioBuffer(vocalsOut);
  await releasePipelineAudioBuffer(accompOut);
  await sep.destroy();
}
```

Segment boundaries can introduce audible artifacts at chunk edges (same tradeoff as offline enhancement). See [segmentation-engine.md](segmentation-engine.md) for policy fields and [memory-and-models.md](memory-and-models.md) for RAM planning.

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

## Types and constants

```ts
import {
  SEPARATION_MODEL_TYPES,
  SEPARATION_STEM_LABELS,
  type SeparationModelType,
  type SeparationInitializeOptions,
  type SeparationEngine,
  type SeparationDetectResult,
  type SeparationResult,
  type SeparateOptions,
} from 'react-native-sherpa-onnx/separation';
```

- **`SeparationModelType`:** `'spleeter' | 'uvr'`
- **`SEPARATION_STEM_LABELS`:** `['vocals', 'accompaniment']` — index labels for the two-stem MVP
- **`SeparationDetectResult`:** shared detection base (`success`, `error`, `detectedModels`, `modelType`, optional `paths`, `languages`, …)
- **`SeparationResult`:** offline `separate()` return — `status`, `totalSegments`, `completedSegments`, `skippedSegments`, optional `failedSegment`, `processingTimeMs`

Live pipeline types (`SeparationLivePipelineOptions`, `SeparationPipelineHandle`): [separation-streaming.md](separation-streaming.md#types-and-constants).

---

## Error codes

Typical **promise rejection `code`** strings from the native layer. Message text varies; use **`code`** for branching when catching.

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
| `OFFLINE_OOM` | Not enough memory for offline separation (JVM `OutOfMemoryError`, catchable C++ `std::bad_alloc` during process, or related native alloc failure). Prefer `segmentation.mode: 'auto'` for long inputs, or process shorter clips. See [segmentation-engine.md](./segmentation-engine.md). OS low-memory kills / hard native aborts may still terminate the process without this code — see [memory-and-models.md](./memory-and-models.md). |
| `SEPARATION_INVALID_ARGUMENT` | TypeScript-side validation (e.g. wrong stem count, unsupported offline segmentation mode). |

Live-overload-specific codes (`LIVE_OFFLINE_SEGMENTATION_REQUIRED`, …): [separation-streaming.md](separation-streaming.md#error-codes).

---

## See also

- [Source separation (live overload)](separation-streaming.md)
- [Speech enhancement (offline)](enhancement-offline.md)
- [STT offline (buffer patterns)](stt-offline.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)
- [Memory and models](memory-and-models.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
