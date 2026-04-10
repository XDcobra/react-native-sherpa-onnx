# Speech Enhancement API

This SDK supports speech enhancement (denoising) with two model families:

- `gtcrn`
- `dpdfnet`

Both offline (full-buffer) and online (streaming) modes are available.

## Import

```ts
import {
  createEnhancement,
  createStreamingEnhancement,
  detectEnhancementModel,
  ENHANCEMENT_MODEL_TYPES,
  type EnhancementDetectResult,
  type EnhancementInitializeOptions,
} from 'react-native-sherpa-onnx/enhancement';
```

## Model Detection

`ModelPathConfig` is imported from `react-native-sherpa-onnx` (same as TTS/STT): `{ type: 'asset' | 'file' | 'auto', path: string }`.

### `detectEnhancementModel(modelPath, options?)`

```ts
function detectEnhancementModel(
  modelPath: ModelPathConfig,
  options?: {
    modelType?: EnhancementModelType | 'auto';
    /** Release / catalog id for name heuristics when it differs from the folder basename (passed to native after `resolveModelPath`). */
    assetName?: string;
  }
): Promise<EnhancementDetectResult>;
```

`EnhancementDetectResult` extends the shared detection base (`success`, `error`, `detectedModels`, `modelType`, optional `languages`, `quantization`, `detectionSources`). It does **not** load the denoiser — use it as a **pre-check** before `createEnhancement` (same idea as `detectTtsModel`).

**Rules (directory scan):**

- Recursively finds `.onnx` under the resolved model directory (depth 4, same family as other detectors).
- Filename / path contains `gtcrn` → candidate `gtcrn`; contains `dpdfnet` or `dpcrn` → candidate `dpdfnet`.
- `modelType: 'auto'` (default): prefers **`gtcrn`** if both ONNX stacks are present, else **`dpdfnet`**.
- **`assetName`**: optional. If omitted, native catalog hints use the **last segment** of `modelPath.path` (with common archive suffixes stripped). If set, that string wins for **languages** / **quantization** when both directory and asset id are passed to native.

**`detectionSources`:** optional ordered trace (`fileListing`, `dirName`, `fallbackOrder`, `explicitModelType`, `nameOnly`). **`nameOnly`** means no file list was scanned (invalid paths for init until you run a full scan) — see native error text when `success` is false.

```ts
import { detectEnhancementModel } from 'react-native-sherpa-onnx/enhancement';

const modelPath = { type: 'file' as const, path: '/absolute/path/to/enhancement-model-dir' };

const det = await detectEnhancementModel(modelPath, { modelType: 'auto' });
if (!det.success) {
  throw new Error(det.error ?? 'Enhancement detection failed');
}
// det.modelType === 'gtcrn' | 'dpdfnet'
// optional: det.languages, det.quantization, det.detectionSources
```

```ts
// Same folder on disk, but release id for catalog hints differs from the folder name (e.g. download manager id):
const det = await detectEnhancementModel(modelPath, {
  modelType: 'auto',
  assetName: 'sherpa-onnx-speech-enhancement-gtcrn-int8',
});
```

## Offline Enhancement

```ts
const enhancement = await createEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
  debug: false,
});

const fromSamples = await enhancement.enhanceSamples(samples, 16000);
// fromSamples.samples: Float32Array
// fromSamples.sampleRate: number

const fromFile = await enhancement.enhanceFile(
  '/absolute/path/to/input.wav',
  '/absolute/path/to/output.wav' // optional
);

await enhancement.destroy();
```

Notes:

- `enhanceFile()` currently expects a readable WAV input path.
- `outputPath` is optional; when provided, denoised WAV is written on native side.

## Online (Streaming) Enhancement

```ts
const streaming = await createStreamingEnhancement({
  modelPath: { type: 'file', path: '/absolute/path/to/model-dir' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
});

const chunkOut = await streaming.feedSamples(chunk, 16000);
const tailOut = await streaming.flush();

await streaming.reset();
await streaming.destroy();
```

`createStreamingEnhancement()` returns:

- `feedSamples(samples, sampleRate)`
- `flush()`
- `reset()`
- `getSampleRate()`
- `getFrameShiftInSamples()`
- `destroy()`

## Types

Main types:

- `EnhancementModelType = 'gtcrn' | 'dpdfnet'`
- `EnhancementDetectResult` — return type of `detectEnhancementModel()` (alias of `EnhancementDetectModelResult` in `src/types/modelDetect.ts`)
- `EnhancedAudio = { samples: Float32Array; sampleRate: number }`
- `EnhancementInitializeOptions`
- `EnhancementEngine`
- `OnlineEnhancementEngine`

## Platform Notes

- Android: implemented via sherpa-onnx Kotlin `OfflineSpeechDenoiser` and `OnlineSpeechDenoiser`.
- iOS: implemented via sherpa-onnx C++ API (`OfflineSpeechDenoiser`, `OnlineSpeechDenoiser`).

