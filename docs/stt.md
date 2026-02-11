# Speech-to-Text (STT)

This guide covers the STT APIs for offline transcription.

| Feature | Status | Notes |
| --- | --- | --- |
| Model initialization | Supported | `initializeSTT()` |
| Offline file transcription | Supported | `transcribeFile()` |
| Unload resources | Supported | `unloadSTT()` |
| Model discovery helpers | Supported | `listAssetModels()` / `resolveModelPath()` |
| Streaming/online recognition | Planned | C API supports online recognizers (model-dependent) |
| Endpointing / VAD-based segmentation | Planned | C API supports endpointing + VAD (model-dependent) |
| Timestamps (segment/word) | Planned | Model-dependent |

## Quick Start

```typescript
import { listAssetModels } from 'react-native-sherpa-onnx';
import {
  initializeSTT,
  transcribeFile,
  unloadSTT,
} from 'react-native-sherpa-onnx/stt';

// 1) Find bundled models (optional)
const models = await listAssetModels();
// pick one folder name from `models` (e.g. 'sherpa-onnx-whisper-tiny-en')

// 2) Initialize with a ModelPathConfig (no string path needed)
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' },
  modelType: 'whisper',
  preferInt8: true,
});

// 3) Transcribe a WAV file (ensure correct sample-rate & channels)
const text = await transcribeFile('/path/to/audio.wav');
console.log('Transcription:', text);

await unloadSTT();
```

## API Reference

### `initializeSTT(options)`

Initialize the speech-to-text engine with a model.

Notes and common pitfalls:
- `modelPath` must point to the model directory containing the expected files for the chosen `modelType` (e.g. `encoder.onnx/decoder.onnx/joiner.onnx` for transducer, `model.onnx` + `tokens.txt` for paraformer).
- If you need a concrete file path (e.g. for audio files), use `resolveModelPath` on a `ModelPathConfig`. Android will return a path inside the APK extraction area; iOS will return the bundle path.
- `preferInt8: true` will attempt to load quantized models when available — faster and smaller, but may affect accuracy.

### `transcribeFile(filePath)`

Transcribe a WAV file (16kHz, mono, 16-bit PCM recommended).

Practical tips:
- Input file sample rate: many models expect 16 kHz or 16/8/48 kHz depending on the model. Resample on the JS/native side before calling `transcribeFile` if needed.
- Channels: most models expect mono. If your audio is stereo, mix down to mono first.
- File format: prefer PCM WAV (16-bit). Floating-point WAV can work if the native loader supports it, but 16-bit is most broadly supported and avoids surprises.
- Long files: for very long audio files, consider chunking into smaller segments and transcribing each segment to avoid large memory spikes.

### `unloadSTT()`

Release STT resources and unload the model.

## Model Setup

See [STT_MODEL_SETUP.md](./STT_MODEL_SETUP.md) for model downloads and setup steps.

## Advanced Examples & Tips

1) Iterate bundled models and initialize the first STT model found:

```typescript
const models = await listAssetModels();
for (const m of models) {
  if (m.hint === 'stt' || m.folder.includes('zipformer') || m.folder.includes('paraformer') || m.folder.includes('whisper')) {
    const r = await initializeSTT({
      modelPath: { type: 'asset', path: `models/${m.folder}` },
      preferInt8: true,
      modelType: 'auto',
    });
    if (r.success) {
      console.log('Loaded', m.folder, r.detectedModels);
      break;
    }
  }
}
```

2) Performance tuning:
- `numThreads`: increase to use more CPU cores on modern devices; be careful on low-memory devices as more threads can increase memory usage.
- Quantized (int8) models are faster and use less memory — use `preferInt8: true` when acceptable.

3) Errors & debugging:
- Check native logs (adb logcat on Android, device logs on iOS) for model load errors (missing files, permission issues, or wrong folder structure).
- If you see OOM errors on mobile, try a smaller model or enable int8 quantized versions.

4) Real-time / streaming scenarios:
- This repo's public API focuses on file-based transcription and model initialization. For real-time streaming ingestion you will need to handle audio capture, resampling, and sending small WAV chunks to `transcribeFile` or add a native streaming wrapper that calls the underlying C++ streaming APIs.

5) Post-processing:
- Model outputs may be raw tokens or lowercased. Apply punctuation/capitalization if your use case needs it.

6) Model-specific notes:
- `whisper` models may require special token handling and can produce timestamps when using extended APIs — check the model README.
- `transducer` / `zipformer` models are optimized for low-latency streaming use cases.
