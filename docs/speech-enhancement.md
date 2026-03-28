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
  type EnhancementInitializeOptions,
} from 'react-native-sherpa-onnx/enhancement';
```

## Model Detection

Use detection before init when you want to show the detected architecture in UI.

```ts
const detect = await detectEnhancementModel(
  { type: 'file', path: '/absolute/path/to/model-dir' },
  { modelType: 'auto' }
);

if (!detect.success) {
  throw new Error(detect.error ?? 'Enhancement detection failed');
}

console.log(detect.modelType); // "gtcrn" | "dpdfnet"
```

Detection logic:

- Scans the model directory recursively for `.onnx`
- `*gtcrn*` filename -> `gtcrn`
- `*dpdfnet*` filename -> `dpdfnet`
- `auto` picks first supported match

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
- `EnhancedAudio = { samples: Float32Array; sampleRate: number }`
- `EnhancementInitializeOptions`
- `EnhancementEngine`
- `OnlineEnhancementEngine`

## Platform Notes

- Android: implemented via sherpa-onnx Kotlin `OfflineSpeechDenoiser` and `OnlineSpeechDenoiser`.
- iOS: implemented via sherpa-onnx C++ API (`OfflineSpeechDenoiser`, `OnlineSpeechDenoiser`).

