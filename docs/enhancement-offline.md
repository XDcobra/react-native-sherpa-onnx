# Speech enhancement (offline)

On-device **batch** speech denoising (**GTCRN**, **DPDFNet**): a populated **`OfflineAudioBuffer`** is denoised into an **empty** **`OfflineAudioBuffer`** at the model sample rate.

**Import path:** `react-native-sherpa-onnx/enhancement`

For **streaming** enhancement (`LiveAudioBuffer` → `LiveAudioBuffer` via **`enhance`**), see [Speech enhancement (streaming)](enhancement-streaming.md).

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

## Quick start

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

---

## Data model and lifetime

| Item | Behaviour |
| --- | --- |
| **Offline engine** | Created with **`createEnhancement`**. Holds native **`OfflineSpeechDenoiser`**. Call **`destroy()`** when done. |
| **`OfflineAudioBuffer` (input)** | Populated buffer from file, samples, or live snapshot. Read-only during enhancement. |
| **`OfflineAudioBuffer` (output)** | Empty buffer created at the denoiser's sample rate. Filled exactly once by **`enhance()`**. Inspect via **`getPipelineAudioBufferInfo()`**, save via **`saveOfflineAudioBufferToWav()`**. |

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

#### `createEnhancement(options)`

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

## Error code quick table

Typical **promise rejection `code`** strings from the native layer. Message text varies; use **`code`** for branching when catching.

| Code | Typical reason |
| --- | --- |
| `DETECT_ERROR` | Detection failed or returned null (Android) |
| `ENHANCEMENT_INIT_ERROR` | Missing `instanceId` / `modelDir`, detection failed, unsupported model type, native init error |
| `ENHANCEMENT_ERROR` | Instance not found, denoise run failed (generic) |
| `ENHANCEMENT_BUFFER_NOT_FOUND` | Unknown or released audio buffer id |
| `ENHANCEMENT_BUFFER_KIND_MISMATCH` | Non-offline buffer passed to offline enhance |
| `ENHANCEMENT_BUFFER_EMPTY` | Input offline buffer has no samples |
| `ENHANCEMENT_OUTPUT_NOT_EMPTY` | Output buffer must be empty (same contract as TTS `synthesize`) |

For streaming and live-pipeline errors (`ONLINE_ENHANCEMENT_*`, `PIPELINE_*`), see [enhancement-streaming.md — Error code quick table](enhancement-streaming.md#error-code-quick-table).

---

## See also

- [Speech enhancement (streaming / live)](enhancement-streaming.md)
- [Speech enhancement (overview)](speech-enhancement.md)
- [STT offline (buffer patterns)](stt-offline.md)
- [TTS offline](tts-offline.md)
- [Pipeline audio buffers (`audiobuffer`)](audiobuffer.md)
- [Execution providers](execution-providers.md)
- [Model setup](model-setup.md)
