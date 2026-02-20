# Speech-to-Text (STT)

This guide covers the STT APIs for offline transcription.

| Feature | Status | Source | Notes |
| --- | --- | --- | --- |
| Model initialization | Supported | Kotlin API | `initializeSTT()`; optional hotwordsFile, hotwordsScore, numThreads, provider, ruleFsts, ruleFars, dither |
| Offline file transcription | Supported | Kotlin API | `transcribeFile()` → full result object |
| Transcribe from samples | Supported | Kotlin API | `transcribeSamples(samples, sampleRate)` |
| Full result (tokens, timestamps, lang, emotion, …) | Supported | Kotlin API | Via `transcribeFile` / `transcribeSamples` return type |
| Hotwords (init) | Supported | Kotlin API | OfflineRecognizerConfig hotwordsFile, hotwordsScore |
| Runtime config | Supported | Kotlin API | `setSttConfig()` (decodingMethod, maxActivePaths, hotwords, blankPenalty, ruleFsts, ruleFars) |
| Unload resources | Supported | Kotlin API | `unloadSTT()` |
| Model discovery helpers | Supported | This package | `listAssetModels()` / `resolveModelPath()` |
| Model downloads | Supported | Kotlin API | Download Manager API |
| Result as JSON string | Planned | C-API | GetOfflineStreamResultAsJson not in Kotlin |
| Batch decode (multiple streams) | Planned | C-API | DecodeMultipleOfflineStreams not in Kotlin |
| Recognizer sample rate / num tokens | Planned | C-API | Not exposed in Kotlin OfflineRecognizer |
| Streaming/online recognition | Planned | C-API | OnlineRecognizer separate API |

## Overview

The STT module provides offline speech recognition: load a model with `initializeSTT`, then transcribe audio from a file with `transcribeFile` or from float samples with `transcribeSamples`. Both return a full result object (`SttRecognitionResult`) with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, and `durations` (model-dependent). Optional init options include hotwords, `numThreads`, `provider`, `ruleFsts`, `ruleFars`, and `dither`; runtime config is available via `setSttConfig` (e.g. decodingMethod, hotwords, ruleFsts, ruleFars). Supported model types include transducer, paraformer, whisper, sense_voice, and others (see feature table).

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

```ts
function initializeSTT(
  options: STTInitializeOptions | ModelPathConfig
): Promise<{ success: boolean; detectedModels: Array<{ type: string; modelDir: string }> }>;
```

Initialize the speech-to-text engine with a model. Use `modelType: 'auto'` to let the SDK detect the model based on files. The JS layer resolves `modelPath` (asset/file/auto) via `resolveModelPath` before calling the native module.

**Options (`STTInitializeOptions` when using object syntax):**

| Option | Type | Description |
| --- | --- | --- |
| `modelPath` | `ModelPathConfig` | `{ type: 'asset' \| 'file' \| 'auto', path: string }` — no raw string path; resolved to absolute path before init. |
| `preferInt8` | `boolean \| undefined` | Prefer int8 quantized models when available (faster, smaller); `undefined` = try int8 first (default). |
| `modelType` | `STTModelType` | `'transducer'` \| `'nemo_transducer'` \| `'paraformer'` \| `'nemo_ctc'` \| `'whisper'` \| `'wenet_ctc'` \| `'sense_voice'` \| `'funasr_nano'` \| `'fire_red_asr'` \| `'moonshine'` \| `'dolphin'` \| `'canary'` \| `'omnilingual'` \| `'medasr'` \| `'telespeech_ctc'` \| `'auto'` (default). |
| `debug` | `boolean` | Enable debug logging in native/sherpa-onnx (default: false). |
| `hotwordsFile` | `string` | Path to hotwords file for keyword boosting. |
| `hotwordsScore` | `number` | Hotwords score (default in native: 1.5). |
| `numThreads` | `number` | Number of threads for inference (default in native: 1). |
| `provider` | `string` | Provider string (e.g. `"cpu"`); stored in config only. |
| `ruleFsts` | `string` | Comma-separated paths to rule FSTs for inverse text normalization (ITN). |
| `ruleFars` | `string` | Comma-separated paths to rule FARs for ITN. |
| `dither` | `number` | Dither for feature extraction (default: 0). |
| `modelOptions` | `SttModelOptions` | Optional model-specific options. Only the block for the **loaded** model type is applied (e.g. when a Whisper model is loaded, only `modelOptions.whisper` is used). See [Model-specific options (modelOptions)](#model-specific-options-modeloptions) below. |

Notes and common pitfalls:
- `modelPath` must point to the model directory containing the expected files for the chosen `modelType` (e.g. `encoder.onnx`/`decoder.onnx`/`joiner.onnx` for transducer, `model.onnx` + `tokens.txt` for paraformer).
- Auto-detection is file-based. Folder names are no longer required to match model types.
- If you need a concrete file path (e.g. for audio files), use `resolveModelPath` on a `ModelPathConfig`. Android will return a path inside the APK extraction area; iOS will return the bundle path.
- `preferInt8: true` will attempt to load quantized models when available — faster and smaller, but may affect accuracy.

### `transcribeFile(filePath)`

```ts
function transcribeFile(filePath: string): Promise<SttRecognitionResult>;
```

Transcribe a WAV file (16 kHz, mono, 16-bit PCM recommended). Returns a full recognition result object.

**Return type `SttRecognitionResult`:**

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | Transcribed text. |
| `tokens` | `string[]` | Token strings. |
| `timestamps` | `number[]` | Timestamps per token (model-dependent; may be empty). |
| `lang` | `string` | Detected or specified language (model-dependent). |
| `emotion` | `string` | Emotion label (e.g. SenseVoice). |
| `event` | `string` | Event label (model-dependent). |
| `durations` | `number[]` | Durations (TDT models). |

Practical tips:
- Input file sample rate: many models expect 16 kHz or 16/8/48 kHz depending on the model. Resample on the JS/native side before calling `transcribeFile` if needed.
- Channels: most models expect mono. If your audio is stereo, mix down to mono first.
- File format: prefer PCM WAV (16-bit). You can use `convertAudioToWav16k` to convert to the optimal format for `transcribeFile`.
- Long files: for very long audio, consider chunking into smaller segments to avoid large memory spikes.

### `transcribeSamples(samples, sampleRate)`

```ts
function transcribeSamples(
  samples: number[],
  sampleRate: number
): Promise<SttRecognitionResult>;
```

Transcribe from float PCM samples (e.g. from microphone or another decoder). `samples` are in [-1, 1], mono; `sampleRate` in Hz. Returns the same `SttRecognitionResult` as `transcribeFile`. Resampling is handled by sherpa-onnx when sample rate differs from the model’s feature config.

### `setSttConfig(options)`

```ts
function setSttConfig(options: SttRuntimeConfig): Promise<void>;
```

Update recognizer config at runtime. Options are merged with the config from initialization; only provided fields are changed.

**Options (`SttRuntimeConfig`):**

| Option | Type | Description |
| --- | --- | --- |
| `decodingMethod` | `string` | e.g. `'greedy_search'`. |
| `maxActivePaths` | `number` | Max active paths (beam search). |
| `hotwordsFile` | `string` | Path to hotwords file. |
| `hotwordsScore` | `number` | Hotwords score. |
| `blankPenalty` | `number` | Blank penalty. |
| `ruleFsts` | `string` | Comma-separated paths to rule FSTs for ITN. |
| `ruleFars` | `string` | Comma-separated paths to rule FARs for ITN. |

### `unloadSTT()`

```ts
function unloadSTT(): Promise<void>;
```

Release STT resources and unload the model. Call before re-initializing with a different model or when the feature is no longer needed.


## Model Setup

See [STT_MODEL_SETUP.md](./STT_MODEL_SETUP.md) for model downloads and setup steps.

### Supported STT model types (Phase 2)

The following model types are supported for detection and config build. Auto-detection uses folder names and file patterns; you can force a type with `modelType`.

| Type | Typical files / structure |
| --- | --- |
| `transducer`, `nemo_transducer` | encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt |
| `paraformer` | model.onnx, tokens.txt |
| `nemo_ctc`, `wenet_ctc`, `sense_voice`, `zipformer_ctc` | model.onnx (or model.int8.onnx), tokens.txt |
| `whisper` | encoder.onnx, decoder.onnx, tokens.txt (no joiner) |
| `funasr_nano` | encoder_adaptor, llm, embedding, tokenizer dir (e.g. vocab.json) |
| `fire_red_asr` | encoder, decoder (folder name hints: fire_red, fire-red) |
| `moonshine` | preprocess.onnx, encode.onnx, uncached_decode.onnx, cached_decode.onnx, tokens.txt |
| `dolphin` | model.onnx, tokens.txt (folder name: dolphin) |
| `canary` | encoder, decoder (folder name: canary) |
| `omnilingual`, `medasr`, `telespeech_ctc` | model.onnx, tokens.txt (folder name hints) |

### Model-specific options (modelOptions)

Pass `modelOptions` in `initializeSTT(options)` to set per-model options. Only the block for the **actually loaded** model type is applied; other keys are ignored (e.g. `modelOptions.whisper` has no effect when a Paraformer model is loaded).

| Model | Key | Options | Description |
| --- | --- | --- | --- |
| **Whisper** | `whisper` | `language?`, `task?` (`'transcribe'` \| `'translate'`), `tailPaddings?`, `enableTokenTimestamps?`, `enableSegmentTimestamps?` | Language code (e.g. `"en"`). With `task: 'translate'`, result `text` is **English** (speech translated to English). **iOS:** only `language`, `task`, `tailPaddings` are applied; `enableTokenTimestamps` and `enableSegmentTimestamps` are **Android only**. |
| **SenseVoice** | `senseVoice` | `language?`, `useItn?` | Language hint; inverse text normalization (default true on Kotlin). |
| **Canary** | `canary` | `srcLang?`, `tgtLang?`, `usePnc?` | Source/target language (default `"en"`); use punctuation (default true). |
| **FunASR Nano** | `funasrNano` | `systemPrompt?`, `userPrompt?`, `maxNewTokens?`, `temperature?`, `topP?`, `seed?`, `language?`, `itn?`, `hotwords?` | LLM/prompt and decoding options; see native defaults in `SttFunAsrNanoModelOptions`. |

Example:

```ts
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny' },
  modelType: 'whisper',
  modelOptions: {
    whisper: { language: 'de', task: 'transcribe' },
  },
});
```

## Mapping to Native API

The JS API in `react-native-sherpa-onnx/stt` resolves model paths and normalizes results; prefer it over calling the TurboModule directly. The following describes how the public API maps to the native bridge and underlying engines.

### TurboModule (spec: `src/NativeSherpaOnnx.ts`)

| JS (public) | TurboModule method | Notes |
| --- | --- | --- |
| `initializeSTT(options)` | `initializeStt(modelDir, preferInt8?, modelType?, debug?, hotwordsFile?, hotwordsScore?, numThreads?, provider?, ruleFsts?, ruleFars?, dither?, modelOptions?)` | JS resolves `modelPath` to `modelDir` via `resolveModelPath`. `modelOptions` is an object with optional `whisper`, `senseVoice`, `canary`, `funasrNano` sub-objects; only the block for the loaded model type is applied. |
| `transcribeFile(filePath)` | `transcribeFile(filePath)` | Returns `Promise<SttRecognitionResult>` (object). |
| `transcribeSamples(samples, sampleRate)` | `transcribeSamples(samples, sampleRate)` | Same return type as `transcribeFile`. |
| `setSttConfig(options)` | `setSttConfig(options)` | `options` is a flat object (e.g. `decodingMethod`, `maxActivePaths`, `hotwordsFile`, `hotwordsScore`, `blankPenalty`, `ruleFsts`, `ruleFars`). |
| `unloadSTT()` | `unloadStt()` | No arguments. |

Result normalization: the native layer returns an object with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, `durations`. The JS layer in `src/stt/index.ts` uses `normalizeSttResult(raw)` so that arrays and strings are always in the expected shape (e.g. empty array if missing).

### Android (Kotlin)

- **Module:** `SherpaOnnxModule` implements `NativeSherpaOnnxSpec`; STT logic lives in `SherpaOnnxSttHelper`.
- **Init:** `initializeStt(...)` builds `OfflineRecognizerConfig` (including `hotwordsFile`, `hotwordsScore`, `numThreads`, `provider`, `ruleFsts`, `ruleFars`, and `FeatureConfig.dither`), creates `OfflineRecognizer`, and stores the last config for `setSttConfig`.
- **Transcribe file:** `transcribeFile(path)` uses sherpa-onnx `ReadWave` → `CreateStream` → `AcceptWaveform` → `Decode` → `GetResult`; the result is converted to a map via `resultToWritableMap(OfflineRecognizerResult)` (text, tokens, timestamps, lang, emotion, event, durations).
- **Transcribe samples:** `transcribeSamples(samples, sampleRate)` creates a stream, converts `ReadableArray` to `FloatArray`, `AcceptWaveform` → `Decode` → `GetResult` → same map, then releases the stream.
- **Runtime config:** `setSttConfig(options)` reads the option map (including `ruleFsts`, `ruleFars`), merges into a copy of `lastRecognizerConfig`, and calls `recognizer.setConfig(merged)`.
- **Unload:** `unloadStt()` releases the recognizer and clears the stored config.

### iOS (ObjC + C++)

- **Module:** `SherpaOnnx` (ObjC) conforms to `NativeSherpaOnnxSpec`; STT is implemented in the `SherpaOnnx (STT)` category; C++ wrapper: `sherpaonnx::SttWrapper` in `sherpa-onnx-stt-wrapper.mm`.
- **Init:** `initializeStt:...:numThreads:provider:ruleFsts:ruleFars:dither:resolve:reject:` calls `SttWrapper::initialize(...)` with the same options. Config is built from model detection, optional hotwords, `numThreads`, `provider`, `ruleFsts`, `ruleFars` (dither is accepted but not applied if the bundled C++ API has no `FeatureConfig.dither`); `OfflineRecognizerConfig` is stored for `setConfig`.
- **Transcribe file:** `transcribeFile:resolve:reject:` calls `SttWrapper::transcribeFile(path)`, which returns `SttRecognitionResult`; the ObjC layer converts it to an `NSDictionary` (text, tokens, timestamps, lang, emotion, event, durations) and resolves the promise.
- **Transcribe samples:** `transcribeSamples:sampleRate:resolve:reject:` converts `NSArray` to `std::vector<float>`, calls `SttWrapper::transcribeSamples(samples, sampleRate)`, then same dictionary conversion.
- **Runtime config:** `setSttConfig:resolve:reject:` maps the options dictionary to `SttRuntimeConfigOptions` (decoding_method, max_active_paths, hotwords_file, hotwords_score, blank_penalty, rule_fsts, rule_fars) and calls `SttWrapper::setConfig(opts)`, which merges into the stored `OfflineRecognizerConfig` and calls `recognizer.SetConfig(config)`.
- **Unload:** `unloadStt:resolve:reject:` releases the wrapper and clears the stored config.

### Underlying engine

On both platforms, sherpa-onnx’s **C API** is used (via Kotlin JNI on Android and C++ `sherpa-onnx/c-api/cxx-api.h` on iOS): `OfflineRecognizer`, `OfflineRecognizerConfig`, `OfflineRecognizerResult`, `CreateStream`, `AcceptWaveform`, `Decode`, `GetResult`, `SetConfig`. The JS API and native bridges hide these details; the table in the feature section at the top of this doc calls out which capabilities come from the Kotlin/ObjC layer vs. the C-API-only features (e.g. result as JSON, batch decode, online recognizer).

### Kotlin Offline API coverage

All **OfflineRecognizer** functions and the options we pass are available in this SDK:

| Kotlin / Config | In this SDK |
| --- | --- |
| `OfflineRecognizer` create stream, decode, get result | Used internally by `transcribeFile` / `transcribeSamples`. |
| Init: model paths, `numThreads`, `provider`, `hotwordsFile`, `hotwordsScore`, `ruleFsts`, `ruleFars`, `dither` | ✅ `initializeSTT` options. |
| `FeatureConfig`: `dither` | ✅ Init option; `sampleRate`/`featureDim` are fixed (16000 / 80) in native. |
| Runtime: `decodingMethod`, `maxActivePaths`, `hotwordsFile`, `hotwordsScore`, `blankPenalty`, `ruleFsts`, `ruleFars` | ✅ `setSttConfig`. |
| `unload` / release | ✅ `unloadSTT`. |

**Not exposed (Kotlin OfflineRecognizerConfig):**

- **HomophoneReplacerConfig** (`hr`: `dictDir`, `lexicon`, `ruleFsts`) — not configurable in this package.
- **Model-specific options** — see "Model-specific options not yet supported" above (Whisper, SenseVoice, FunASR Nano, Canary, etc.).

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
