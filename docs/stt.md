# Speech-to-Text (STT)

This guide covers the STT APIs for offline transcription.

## Table of contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [createSTT(options)](#createsttoptions)
  - [SttEngine: transcribeFile(filePath)](#sttengine-transcribefilefilepath)
  - [SttEngine: transcribeSamples(samples, sampleRate)](#sttengine-transcribesamplessamples-samplerate)
  - [SttEngine: setConfig(options)](#sttengine-setconfigoptions)
  - [SttEngine: destroy()](#sttengine-destroy)
  - [Hotwords (contextual biasing)](./hotwords.md)
- [Model Setup](#model-setup)
  - [Supported STT model types](#supported-stt-model-types)
  - [Model-specific options (modelOptions)](#model-specific-options-modeloptions)
  - [Whisper language codes (getWhisperLanguages)](#whisper-language-codes-getwhisperlanguages)
- [Mapping to Native API](#mapping-to-native-api)
  - [TurboModule](#turbomodule-spec-srcnativesherpaonnxts)
  - [Android (Kotlin)](#android-kotlin)
  - [iOS (ObjC + C++)](#ios-objc--c)
  - [Underlying engine](#underlying-engine)
- [Advanced Examples & Tips](#advanced-examples--tips)

| Feature | Status | Source | Notes |
| --- | --- | --- | --- |
| Model type detection (no init) | ✅ | Native | `detectSttModel(modelPath, options?)` — see [Model Setup: detectSttModel / detectTtsModel](./MODEL_SETUP.md#model-type-detection-without-initialization) |
| Model initialization | ✅ | Kotlin API | `createSTT()` → `SttEngine`; optional hotwordsFile, hotwordsScore, numThreads, provider, ruleFsts, ruleFars, dither |
| Offline file transcription | ✅ | Kotlin API | `stt.transcribeFile(filePath)` → full result object |
| Transcribe from samples | ✅ | Kotlin API | `stt.transcribeSamples(samples, sampleRate)` |
| Full result (tokens, timestamps, lang, emotion, …) | ✅ | Kotlin API | Via `stt.transcribeFile` / `stt.transcribeSamples` return type |
| Hotwords (init) | ✅ | Kotlin API | OfflineRecognizerConfig hotwordsFile, hotwordsScore |
| Runtime config | ✅ | Kotlin API | `stt.setConfig()` (decodingMethod, maxActivePaths, hotwords, blankPenalty, ruleFsts, ruleFars) |
| Unload resources | ✅ | Kotlin API | `stt.destroy()` |
| Model discovery helpers | ✅ | This package | `listAssetModels()` / `resolveModelPath()` |
| Model downloads | ✅ | Kotlin API | Download Manager API |
| Result as JSON string | Planned | C-API | GetOfflineStreamResultAsJson not in Kotlin |
| Batch decode (multiple streams) | Planned | C-API | DecodeMultipleOfflineStreams not in Kotlin |
| Recognizer sample rate / num tokens | Planned | C-API | Not exposed in Kotlin OfflineRecognizer |
| Streaming/online recognition | Planned | C-API | OnlineRecognizer separate API |
| Segment timestamps (Whisper) | Planned | C-API | segment_timestamps / segment_durations / segment_texts; C-API has them, Kotlin/RN bridge to follow |

## Overview

The STT module provides offline speech recognition: create an engine with `createSTT`, then transcribe audio from a file with `stt.transcribeFile` or from float samples with `stt.transcribeSamples`. Both return a full result object (`SttRecognitionResult`) with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, and `durations` (model-dependent). Call `stt.destroy()` when done. Optional create options include hotwords, `numThreads`, `provider`, `ruleFsts`, `ruleFars`, and `dither`; runtime config is available via `stt.setConfig` (e.g. decodingMethod, hotwords, ruleFsts, ruleFars). Supported model types include transducer, paraformer, whisper, sense_voice, and others (see feature table).

## Quick Start

```typescript
import { listAssetModels } from 'react-native-sherpa-onnx';
import {
  createSTT,
} from 'react-native-sherpa-onnx/stt';

// 1) Find bundled models (optional)
const models = await listAssetModels();
// pick one folder name from `models` (e.g. 'sherpa-onnx-whisper-tiny-en')

// 2) Create an STT engine with a ModelPathConfig (no string path needed)
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' },
  modelType: 'auto',
  preferInt8: true,
});

// 3) Transcribe a WAV file (ensure correct sample-rate & channels)
const result = await stt.transcribeFile('/path/to/audio.wav');
console.log('Transcription:', result.text);
// result also has: tokens, timestamps, lang, emotion, event, durations

await stt.destroy();
```

## API Reference

### `createSTT(options)`

```ts
function createSTT(
  options: STTInitializeOptions | ModelPathConfig
): Promise<SttEngine>;
```

Create an STT engine instance. Returns `Promise<SttEngine>`. You **must** call `stt.destroy()` when done to free native resources. Use `modelType: 'auto'` to let the SDK detect the model based on files. The JS layer resolves `modelPath` (asset/file/auto) via `resolveModelPath` before calling the native module.

**Options (`STTInitializeOptions` when using object syntax):**

| Option | Type | Description |
| --- | --- | --- |
| `modelPath` | `ModelPathConfig` | `{ type: 'asset' \| 'file' \| 'auto', path: string }` — no raw string path; resolved to absolute path before init. |
| `preferInt8` | `boolean \| undefined` | Prefer int8 quantized models when available (faster, smaller); `undefined` = try int8 first (default). |
| `modelType` | `STTModelType` | `'transducer'` \| `'nemo_transducer'` \| `'paraformer'` \| `'nemo_ctc'` \| `'whisper'` \| `'wenet_ctc'` \| `'sense_voice'` \| `'funasr_nano'` \| `'fire_red_asr'` \| `'moonshine'` \| `'dolphin'` \| `'canary'` \| `'omnilingual'` \| `'medasr'` \| `'telespeech_ctc'` \| `'auto'` (default). |
| `debug` | `boolean` | Enable debug logging in native/sherpa-onnx (default: false). |
| `hotwordsFile` | `string` | Path to hotwords file for contextual biasing. **Only supported for transducer models** (`transducer`, `nemo_transducer`). For other model types the SDK rejects with `HOTWORDS_NOT_SUPPORTED`. Use `sttSupportsHotwords(modelType)` to show/hide hotword options. |
| `hotwordsScore` | `number` | Hotwords score (default in native: 1.5). Only applies when `hotwordsFile` is set (transducer only). |
| `numThreads` | `number` | Number of threads for inference (default in native: 1). |
| `provider` | `string` | Provider string (e.g. `"cpu"`); stored in config only. |
| `ruleFsts` | `string` | Comma-separated paths to rule FSTs for inverse text normalization (ITN). |
| `ruleFars` | `string` | Comma-separated paths to rule FARs for ITN. |
| `dither` | `number` | Dither for feature extraction (default: 0). |
| `modelOptions` | `SttModelOptions` | Optional model-specific options. Only the block for the **loaded** model type is applied (e.g. when a Whisper model is loaded, only `modelOptions.whisper` is used). See [Model-specific options (modelOptions)](#model-specific-options-modeloptions) below. |

**Return value:** `Promise<SttEngine>`. The engine's creation resolves after the model is loaded; you can call `stt.getModelInfo()` (if exposed) or rely on the resolved promise. When you pass a non-empty `hotwordsFile`, the SDK auto-switches decoding to `modified_beam_search`. Use `sttSupportsHotwords(modelType)` to decide whether to show hotword options.

Notes and common pitfalls:
- `modelPath` must point to the model directory containing the expected files for the chosen `modelType` (e.g. `encoder.onnx`/`decoder.onnx`/`joiner.onnx` for transducer, `model.onnx` + `tokens.txt` for paraformer).
- Auto-detection is file-based. Folder names are no longer required to match model types.
- If you need a concrete file path (e.g. for audio files), use `resolveModelPath` on a `ModelPathConfig`. Android will return a path inside the APK extraction area; iOS will return the bundle path.
- `preferInt8: true` will attempt to load quantized models when available — faster and smaller, but may affect accuracy.
- **Hotwords:** Only transducer models support hotwords. Passing `hotwordsFile` for Whisper, Paraformer, etc. causes the promise to reject with code `HOTWORDS_NOT_SUPPORTED`. Use `sttSupportsHotwords(modelType)` (from `react-native-sherpa-onnx/stt`) to show hotword options only for transducer.

### `SttEngine: transcribeFile(filePath)`

```ts
stt.transcribeFile(filePath: string): Promise<SttRecognitionResult>;
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
| `hotwordsFile` | `string` | Path to hotwords file. Only allowed for transducer models; otherwise rejects with `HOTWORDS_NOT_SUPPORTED`. |
| `hotwordsScore` | `number` | Hotwords score. |
| `blankPenalty` | `number` | Blank penalty. |
| `ruleFsts` | `string` | Comma-separated paths to rule FSTs for ITN. |
| `ruleFars` | `string` | Comma-separated paths to rule FARs for ITN. |

### `SttEngine: destroy()`

```ts
stt.destroy(): Promise<void>;
```

Release STT resources and unload the model. **Must** be called when the engine is no longer needed to free native resources.

### Hotwords (contextual biasing)

See [Hotwords (contextual biasing)](./hotwords.md) for supported model types, file format, validation, and modeling units.


## Model Setup

See [STT_MODEL_SETUP.md](./STT_MODEL_SETUP.md) for model downloads and setup steps.

### Supported STT model types

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

Pass `modelOptions` in `createSTT(options)` to set per-model options. Only the block for the **actually loaded** model type is applied; other keys are ignored (e.g. `modelOptions.whisper` has no effect when a Paraformer model is loaded).

| Model | Key | Options | Description |
| --- | --- | --- | --- |
| **Whisper** | `whisper` | `language?`, `task?` (`'transcribe'` \| `'translate'`), `tailPaddings?`, `enableTokenTimestamps?`, `enableSegmentTimestamps?` | Language code (e.g. `"en"`, `"de"`). **Only use valid codes** — invalid values can crash the app. Use [getWhisperLanguages()](#whisper-language-codes-getwhisperlanguages) to get the full list of `{ id, name }`. With `task: 'translate'`, result `text` is **English**. **iOS:** only `language`, `task`, `tailPaddings` are applied; `enableTokenTimestamps` and `enableSegmentTimestamps` are **Android only**. |
| **SenseVoice** | `senseVoice` | `language?`, `useItn?` | Language hint; inverse text normalization (default true on Kotlin). |
| **Canary** | `canary` | `srcLang?`, `tgtLang?`, `usePnc?` | Source/target language (default `"en"`); use punctuation (default true). |
| **FunASR Nano** | `funasrNano` | `systemPrompt?`, `userPrompt?`, `maxNewTokens?`, `temperature?`, `topP?`, `seed?`, `language?`, `itn?`, `hotwords?` | LLM/prompt and decoding options; see native defaults in `SttFunAsrNanoModelOptions`. |

Example:

```ts
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny' },
  modelType: 'whisper',
  modelOptions: {
    whisper: { language: 'de', task: 'transcribe' },
  },
});
// ... use stt ... then await stt.destroy();
```

### Whisper language codes (getWhisperLanguages)

Whisper’s `modelOptions.whisper.language` accepts only specific ISO-style codes (e.g. `"en"`, `"de"`, `"yue"`). Passing an invalid code can cause a native crash. The SDK exposes the full list of supported codes and display names so you can build a dropdown or picker instead of free text.

- **`getWhisperLanguages(): readonly WhisperLanguage[]`** — Returns the list of all Whisper-supported languages. Each entry has `id` (the code to pass as `language`) and `name` (e.g. `"english"`, `"german"`).
- **`WHISPER_LANGUAGES`** — The same list as a constant (readonly array).

**Type:** `WhisperLanguage` is `{ id: string; name: string }`.

Example (e.g. for a language dropdown):

```ts
import { getWhisperLanguages } from 'react-native-sherpa-onnx/stt';

const languages = getWhisperLanguages();
// languages[0] => { id: 'en', name: 'english' }
// Use id as modelOptions.whisper.language; show name (or "name (id)") in the UI.
```

Use an empty string or omit `language` for auto-detection.

## Mapping to Native API

The JS API in `react-native-sherpa-onnx/stt` resolves model paths and normalizes results; prefer it over calling the TurboModule directly. The following describes how the public API maps to the native bridge and underlying engines.

### TurboModule (spec: `src/NativeSherpaOnnx.ts`)

| JS (public) | TurboModule method | Notes |
| --- | --- | --- |
| `createSTT(options)` | `initializeStt(instanceId, modelDir, ...)` | JS generates `instanceId`, resolves `modelPath` to `modelDir` via `resolveModelPath`. Returns `SttEngine` with bound `instanceId`. |
| `stt.transcribeFile(filePath)` | `transcribeFile(instanceId, filePath)` | Returns `Promise<SttRecognitionResult>` (object). |
| `stt.transcribeSamples(samples, sampleRate)` | `transcribeSamples(instanceId, samples, sampleRate)` | Same return type as `transcribeFile`. |
| `stt.setConfig(options)` | `setSttConfig(instanceId, options)` | `options` is a flat object (e.g. `decodingMethod`, `maxActivePaths`, `hotwordsFile`, `hotwordsScore`, `blankPenalty`, `ruleFsts`, `ruleFars`). |
| `stt.destroy()` | `unloadStt(instanceId)` | Mandatory cleanup. |

Result normalization: the native layer returns an object with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, `durations`. The JS layer in `src/stt/index.ts` uses `normalizeSttResult(raw)` so that arrays and strings are always in the expected shape (e.g. empty array if missing).

### Android (Kotlin)

- **Module:** `SherpaOnnxModule` implements `NativeSherpaOnnxSpec`; STT logic lives in `SherpaOnnxSttHelper`.
- **Init:** `initializeStt(instanceId, ...)` creates or looks up an instance in a map, builds `OfflineRecognizerConfig` (including `hotwordsFile`, `hotwordsScore`, `numThreads`, `provider`, `ruleFsts`, `ruleFars`, and `FeatureConfig.dither`), creates `OfflineRecognizer`, and stores it per instance for `setSttConfig`.
- **Transcribe file:** `transcribeFile(instanceId, path)` looks up the instance, uses sherpa-onnx `ReadWave` → `CreateStream` → `AcceptWaveform` → `Decode` → `GetResult`; the result is converted to a map via `resultToWritableMap(OfflineRecognizerResult)` (text, tokens, timestamps, lang, emotion, event, durations).
- **Transcribe samples:** `transcribeSamples(instanceId, samples, sampleRate)` looks up the instance, creates a stream, converts `ReadableArray` to `FloatArray`, `AcceptWaveform` → `Decode` → `GetResult` → same map, then releases the stream.
- **Runtime config:** `setSttConfig(instanceId, options)` looks up the instance, reads the option map (including `ruleFsts`, `ruleFars`), merges into a copy of the instance's config, and calls `recognizer.setConfig(merged)`.
- **Unload:** `unloadStt(instanceId)` releases the recognizer for that instance and removes it from the map.

### iOS (ObjC + C++)

- **Module:** `SherpaOnnx` (ObjC) conforms to `NativeSherpaOnnxSpec`; STT is implemented in the `SherpaOnnx (STT)` category; C++ wrapper: `sherpaonnx::SttWrapper` in `sherpa-onnx-stt-wrapper.mm`.
- **Init:** `initializeStt:instanceId:modelDir:...:resolve:reject:` creates or looks up an instance in `g_stt_instances`, calls `SttWrapper::initialize(...)` for that instance. Config is built from model detection, optional hotwords, `numThreads`, `provider`, `ruleFsts`, `ruleFars` (dither is accepted but not applied if the bundled C++ API has no `FeatureConfig.dither`).
- **Transcribe file:** `transcribeFile:instanceId:filePath:resolve:reject:` looks up the instance, calls `SttWrapper::transcribeFile(path)`, which returns `SttRecognitionResult`; the ObjC layer converts it to an `NSDictionary` (text, tokens, timestamps, lang, emotion, event, durations) and resolves the promise.
- **Transcribe samples:** `transcribeSamples:instanceId:samples:sampleRate:resolve:reject:` looks up the instance, converts `NSArray` to `std::vector<float>`, calls `SttWrapper::transcribeSamples(samples, sampleRate)`, then same dictionary conversion.
- **Runtime config:** `setSttConfig:instanceId:options:resolve:reject:` looks up the instance, maps the options dictionary to `SttRuntimeConfigOptions` (decoding_method, max_active_paths, hotwords_file, hotwords_score, blank_penalty, rule_fsts, rule_fars) and calls `SttWrapper::setConfig(opts)`.
- **Unload:** `unloadStt:instanceId:resolve:reject:` releases the wrapper for that instance and removes it from `g_stt_instances`.

### Underlying engine

On both platforms, sherpa-onnx’s **C API** is used (via Kotlin JNI on Android and C++ `sherpa-onnx/c-api/cxx-api.h` on iOS): `OfflineRecognizer`, `OfflineRecognizerConfig`, `OfflineRecognizerResult`, `CreateStream`, `AcceptWaveform`, `Decode`, `GetResult`, `SetConfig`. The JS API and native bridges hide these details; the table in the feature section at the top of this doc calls out which capabilities come from the Kotlin/ObjC layer vs. the C-API-only features (e.g. result as JSON, batch decode, online recognizer).

## Advanced Examples & Tips

1) Iterate bundled models and create the first STT engine found:

```typescript
const models = await listAssetModels();
let stt = null;
for (const m of models) {
  if (m.hint !== 'stt') continue;
  try {
    stt = await createSTT({
      modelPath: { type: 'asset', path: `models/${m.folder}` },
      preferInt8: true,
      modelType: 'auto',
    });
    console.log('Loaded', m.folder);
    break;
  } catch (e) {
    // try next model
  }
}
// ... use stt ... then if (stt) await stt.destroy();
```

2) Performance tuning:
- Quantized (int8) models are faster and use less memory — use `preferInt8: true` when acceptable.

3) Post-processing:
- Model outputs may be raw tokens or lowercased. Apply punctuation/capitalization if your use case needs it.

4) Model-specific notes:
- `whisper` models may require special token handling and can produce timestamps; see full result object.
- `transducer` / `zipformer` models are optimized for low-latency use cases.
