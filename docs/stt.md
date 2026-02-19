# Speech-to-Text (STT)

This guide covers the STT APIs for offline transcription.

| Feature | Status | Source | Notes |
| --- | --- | --- | --- |
| Model initialization | Supported | Kotlin API | `initializeSTT()`; optional hotwordsFile, hotwordsScore |
| Offline file transcription | Supported | Kotlin API | `transcribeFile()` → full result object |
| Transcribe from samples | Supported | Kotlin API | `transcribeSamples(samples, sampleRate)` |
| Full result (tokens, timestamps, lang, emotion, …) | Supported | Kotlin API | Via `transcribeFile` / `transcribeSamples` return type |
| Hotwords (init) | Supported | Kotlin API | OfflineRecognizerConfig hotwordsFile, hotwordsScore |
| Runtime config | Supported | Kotlin API | `setSttConfig()` |
| Unload resources | Supported | Kotlin API | `unloadSTT()` |
| Model discovery helpers | Supported | This package | `listAssetModels()` / `resolveModelPath()` |
| Model downloads | Supported | Kotlin API | Download Manager API |
| Result as JSON string | Planned | C-API | GetOfflineStreamResultAsJson not in Kotlin |
| Batch decode (multiple streams) | Planned | C-API | DecodeMultipleOfflineStreams not in Kotlin |
| Recognizer sample rate / num tokens | Planned | C-API | Not exposed in Kotlin OfflineRecognizer |
| Streaming/online recognition | Planned | C-API | OnlineRecognizer separate API |

## Overview

The STT module provides offline speech recognition: load a model with `initializeSTT`, then transcribe audio from a file with `transcribeFile` or from float samples with `transcribeSamples`. Both return a full result object (`SttRecognitionResult`) with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, and `durations` (model-dependent). Optional hotwords can be set at init; runtime config is available via `setSttConfig`. Supported model types include transducer, paraformer, whisper, sense_voice, and others (see feature table).

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
  modelType: 'auto',
  preferInt8: true,
});

// 3) Transcribe a WAV file (ensure correct sample-rate & channels)
const result = await transcribeFile('/path/to/audio.wav');
console.log('Transcription:', result.text);
// result also has: tokens, timestamps, lang, emotion, event, durations

await unloadSTT();
```

## API Reference

### `initializeSTT(options)`

Initialize the speech-to-text engine with a model. Use `modelType: 'auto'` to let the SDK detect the model based on files.

Notes and common pitfalls:
- `modelPath` must point to the model directory containing the expected files for the chosen `modelType` (e.g. `encoder.onnx/decoder.onnx/joiner.onnx` for transducer, `model.onnx` + `tokens.txt` for paraformer).
- Auto-detection is file-based. Folder names are no longer required to match model types.
- If you need a concrete file path (e.g. for audio files), use `resolveModelPath` on a `ModelPathConfig`. Android will return a path inside the APK extraction area; iOS will return the bundle path.
- `preferInt8: true` will attempt to load quantized models when available — faster and smaller, but may affect accuracy.
- Optional: `hotwordsFile` (path to hotwords file) and `hotwordsScore` (default 1.5) for keyword boosting.

### `transcribeFile(filePath)`

Transcribe a WAV file (16kHz, mono, 16-bit PCM recommended). Returns a `SttRecognitionResult` with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, and `durations`.

Practical tips:
- Input file sample rate: many models expect 16 kHz or 16/8/48 kHz depending on the model. Resample on the JS/native side before calling `transcribeFile` if needed.
- Channels: most models expect mono. If your audio is stereo, mix down to mono first.
- File format: prefer PCM WAV (16-bit). Floating-point WAV can work if the native loader supports it, but 16-bit is most broadly supported and avoids surprises. You can use `convertAudioToWav16k` to directly format your audio format to the optimal audio format for `transcribeFile`
- Long files: for very long audio files, consider chunking into smaller segments and transcribing each segment to avoid large memory spikes.

### `transcribeSamples(samples, sampleRate)`

Transcribe from float PCM samples (e.g. from microphone or another decoder). `samples` is `number[]` in [-1, 1]; `sampleRate` in Hz. Returns the same `SttRecognitionResult` as `transcribeFile`.

### `setSttConfig(options)`

Update recognizer config at runtime (e.g. `decodingMethod`, `maxActivePaths`, `hotwordsFile`, `hotwordsScore`, `blankPenalty`). Options are merged with the config from initialization.

### `unloadSTT()`

Release STT resources and unload the model.

## Model Setup

See [STT_MODEL_SETUP.md](./STT_MODEL_SETUP.md) for model downloads and setup steps.

## Mapping to Native API

The TurboModule exposes: `initializeStt(modelDir, preferInt8?, modelType?, debug?, hotwordsFile?, hotwordsScore?)`, `transcribeFile(filePath)`, `transcribeSamples(samples, sampleRate)`, `setSttConfig(options)`, `unloadStt()`. The JS layer in `react-native-sherpa-onnx/stt` resolves model paths and maps options; prefer the public API over calling the TurboModule directly.

## Advanced Examples & Tips

1) Iterate bundled models and initialize the first STT model found:

```typescript
const models = await listAssetModels();
for (const m of models) {
  if (m.hint !== 'stt') continue;
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
```

2) Performance tuning:
- Quantized (int8) models are faster and use less memory — use `preferInt8: true` when acceptable.

3) Errors & debugging:
- Check native logs (adb logcat on Android, device logs on iOS) for model load errors (missing files, permission issues, or wrong folder structure).
- If you see OOM errors on mobile, try a smaller model or enable int8 quantized versions.

4) Real-time / streaming scenarios:
- For live audio, use `transcribeSamples` with chunks of float samples (e.g. from a recorder). Streaming/online recognition with the OnlineRecognizer is a separate C-API feature not yet exposed in this bridge.

5) Post-processing:
- Model outputs may be raw tokens or lowercased. Apply punctuation/capitalization if your use case needs it.

6) Model-specific notes:
- `whisper` models may require special token handling and can produce timestamps; see full result object.
- `transducer` / `zipformer` models are optimized for low-latency use cases.
