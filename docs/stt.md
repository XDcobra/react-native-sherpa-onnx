# Speech-to-Text (STT)

Offline speech recognition: transcribe audio files or float PCM samples using on-device models.

**Import path:** `react-native-sherpa-onnx/stt`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [createSTT()](#createsttoptions)
  - [detectSttModel()](#detectsttmodelmodelpath-options)
  - [SttEngine](#sttengine)
  - [SttRecognitionResult](#sttrecognitionresult)
  - [SttRuntimeConfig](#sttruntimeconfig)
  - [Types & Constants](#types--constants)
- [Model-Specific Options](#model-specific-options)
  - [Supported Model Types (File Patterns)](#supported-model-types-file-patterns)
  - [Validation (Required Files)](#validation-required-files)
  - [Model Language Helpers](#model-language-helpers)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [Native Bridge Mapping](#native-bridge-mapping)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| Model type detection | ✅ | `detectSttModel()` — file-based, includes required-files validation |
| Model initialization | ✅ | `createSTT()` → `SttEngine` |
| File transcription | ✅ | `stt.transcribeFile(path)` |
| Sample transcription | ✅ | `stt.transcribeSamples(samples, sampleRate)` |
| Full result object | ✅ | text, tokens, timestamps, lang, emotion, event, durations |
| Hotwords (transducer) | ✅ | See [hotwords.md](hotwords.md) |
| Runtime config | ✅ | `stt.setConfig()` — decodingMethod, hotwords, ruleFsts, etc. |
| Model downloads | ✅ | Via [Download Manager](download-manager.md) |
| Streaming/online | ✅ | Separate API — see [stt-streaming.md](stt-streaming.md) |

Create an engine with `createSTT()`, then transcribe audio from a file with `stt.transcribeFile()` or from float samples with `stt.transcribeSamples()`. Both return a `SttRecognitionResult` with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, and `durations` (model-dependent). Call `stt.destroy()` when done.

Supported model types: `transducer`, `nemo_transducer`, `paraformer`, `nemo_ctc`, `wenet_ctc`, `sense_voice`, `zipformer_ctc`, `ctc`, `whisper`, `funasr_nano`, `fire_red_asr`, `moonshine`, `dolphin`, `canary`, `omnilingual`, `medasr`, `telespeech_ctc`, `auto`.

---

## Quick Start

```typescript
import { createSTT } from 'react-native-sherpa-onnx/stt';

// 1) Create an STT engine (auto-detects model type from files)
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' },
  modelType: 'auto',
  preferInt8: true,
});

// 2) Transcribe a WAV file (16 kHz mono recommended)
const result = await stt.transcribeFile('/path/to/audio.wav');
console.log('Text:', result.text);

// 3) Cleanup
await stt.destroy();
```

---

## API Reference

### `createSTT(options)`

```ts
function createSTT(
  options: STTInitializeOptions | ModelPathConfig
): Promise<SttEngine>;
```

Create an STT engine instance. You **must** call `stt.destroy()` when done to free native resources. Use `modelType: 'auto'` to let the SDK detect the model from directory files.

**Options (`STTInitializeOptions`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `modelPath` | `ModelPathConfig` | — | `{ type: 'asset' \| 'file' \| 'auto', path }` |
| `modelType` | `STTModelType` | `'auto'` | Model type or `'auto'` for file-based detection |
| `preferInt8` | `boolean` | `undefined` | Prefer int8 quantized models (faster, smaller); `undefined` = try int8 first |
| `debug` | `boolean` | `false` | Enable debug logging in native layer |
| `hotwordsFile` | `string` | — | Path to hotwords file (**transducer only**). See [hotwords.md](hotwords.md) |
| `hotwordsScore` | `number` | `1.5` | Hotwords boost score |
| `modelingUnit` | `string` | — | `'cjkchar'` \| `'bpe'` \| `'cjkchar+bpe'` for hotwords tokenization |
| `bpeVocab` | `string` | — | Path to BPE vocab (when modelingUnit is `'bpe'` or `'cjkchar+bpe'`) |
| `numThreads` | `number` | `1` | Inference threads |
| `provider` | `string` | — | `'cpu'`, `'qnn'`, `'nnapi'`, `'xnnpack'`. See [execution-providers.md](execution-providers.md) |
| `ruleFsts` | `string` | — | Comma-separated rule FST paths for inverse text normalization |
| `ruleFars` | `string` | — | Comma-separated rule FAR paths for ITN |
| `dither` | `number` | `0` | Feature extraction dither |
| `modelOptions` | `SttModelOptions` | — | Per-model options (see [Model-Specific Options](#model-specific-options)) |

When you pass a non-empty `hotwordsFile`, the SDK auto-switches the decoding method to `modified_beam_search` (and ensures `maxActivePaths ≥ 4`). Use `sttSupportsHotwords(modelType)` to check support before setting hotwords.

---

### `detectSttModel(modelPath, options?)`

```ts
function detectSttModel(
  modelPath: ModelPathConfig,
  options?: { preferInt8?: boolean; modelType?: STTModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
}>;
```

Detect model type without loading. Includes required-files validation — returns `success: false` with a specific `error` message when required files are missing.

```typescript
const result = await detectSttModel(
  { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' },
  { preferInt8: true }
);
if (result.success && result.modelType === 'whisper') {
  // Show Whisper-specific options (language, task, etc.)
}
```

---

### `SttEngine`

Returned by `createSTT()`. Call `destroy()` when done.

| Method | Signature | Description |
| --- | --- | --- |
| `instanceId` | `string` (read-only) | Engine instance ID |
| `transcribeFile` | `(filePath: string) => Promise<SttRecognitionResult>` | Transcribe a WAV file (16 kHz mono recommended) |
| `transcribeSamples` | `(samples: number[], sampleRate: number) => Promise<SttRecognitionResult>` | Transcribe float PCM samples in [-1, 1] |
| `setConfig` | `(options: SttRuntimeConfig) => Promise<void>` | Update recognizer config at runtime |
| `destroy` | `() => Promise<void>` | Release native resources (**mandatory**) |

---

### `SttRecognitionResult`

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | Transcribed text |
| `tokens` | `string[]` | Token strings |
| `timestamps` | `number[]` | Per-token timestamps (model-dependent; may be empty) |
| `lang` | `string` | Detected language (model-dependent) |
| `emotion` | `string` | Emotion label (e.g. SenseVoice) |
| `event` | `string` | Event label (model-dependent) |
| `durations` | `number[]` | Durations (TDT models) |

---

### `SttRuntimeConfig`

Update recognizer config at runtime via `stt.setConfig()`. Only provided fields are changed.

| Option | Type | Description |
| --- | --- | --- |
| `decodingMethod` | `string` | e.g. `'greedy_search'`, `'modified_beam_search'` |
| `maxActivePaths` | `number` | Beam search size |
| `hotwordsFile` | `string` | Hotwords file path (transducer only) |
| `hotwordsScore` | `number` | Hotwords score |
| `blankPenalty` | `number` | Blank penalty |
| `ruleFsts` | `string` | Rule FST paths for ITN |
| `ruleFars` | `string` | Rule FAR paths for ITN |

---

### Types & Constants

```ts
import {
  createSTT,
  detectSttModel,
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  getWhisperLanguages,
  getSenseVoiceLanguages,
  getCanaryLanguages,
  getFunasrNanoLanguages,
  getFunasrMltNanoLanguages,
} from 'react-native-sherpa-onnx/stt';

import type {
  STTInitializeOptions,
  STTModelType,
  SttModelOptions,
  SttRecognitionResult,
  SttRuntimeConfig,
  SttEngine,
  SttInitResult,
  SttModelLanguage,
} from 'react-native-sherpa-onnx/stt';
```

---

## Model-Specific Options

Pass via `modelOptions` in `createSTT()`. Only the block matching the loaded model type is applied; others are ignored.

| Model | Key | Options |
| --- | --- | --- |
| **Whisper** | `whisper` | `language?`, `task?` (`'transcribe'` \| `'translate'`), `tailPaddings?`, `enableTokenTimestamps?` (Android only), `enableSegmentTimestamps?` (Android only) |
| **SenseVoice** | `senseVoice` | `language?`, `useItn?` |
| **Canary** | `canary` | `srcLang?`, `tgtLang?`, `usePnc?` |
| **FunASR Nano** | `funasrNano` | `systemPrompt?`, `userPrompt?`, `maxNewTokens?`, `temperature?`, `topP?`, `seed?`, `language?`, `itn?`, `hotwords?` |

```typescript
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny' },
  modelType: 'whisper',
  modelOptions: {
    whisper: { language: 'de', task: 'transcribe' },
  },
});
```

### Supported Model Types (File Patterns)

| Type | Typical Files |
| --- | --- |
| `transducer`, `nemo_transducer` | encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt |
| `paraformer` | model.onnx, tokens.txt |
| `whisper` | encoder.onnx, decoder.onnx, tokens.txt (no joiner) |
| `moonshine` | preprocess.onnx, encode.onnx, uncached_decode.onnx, cached_decode.onnx, tokens.txt |
| `funasr_nano` | encoder_adaptor, llm, embedding, tokenizer dir |
| `nemo_ctc`, `wenet_ctc`, `sense_voice`, `zipformer_ctc` | model.onnx, tokens.txt |
| `fire_red_asr`, `canary` | encoder, decoder directories |
| `dolphin`, `omnilingual`, `medasr`, `telespeech_ctc` | model.onnx, tokens.txt |

Auto-detection is file-based — folder names are irrelevant. Keep file names as expected by sherpa-onnx.

### Validation (Required Files)

After detection, the SDK validates all required files are present. Missing files cause `success: false` with error format:

```
STT <ModelType>: missing required files in <modelDir>: <field1>, <field2>
```

Example: `STT Transducer: missing required files in /data/models/zipformer: encoder, tokens`

This runs automatically in both `detectSttModel()` and `createSTT()`.

### Model Language Helpers

Several models accept a language hint. The SDK provides per-model lists of valid codes with display names so you can build dropdowns.

| Model | Getter | Use For |
| --- | --- | --- |
| Whisper | `getWhisperLanguages()` | `modelOptions.whisper.language` |
| SenseVoice | `getSenseVoiceLanguages()` | `modelOptions.senseVoice.language` |
| Canary | `getCanaryLanguages()` | `modelOptions.canary.srcLang` / `tgtLang` |
| FunASR Nano | `getFunasrNanoLanguages()` | `modelOptions.funasrNano.language` |
| FunASR MLT Nano | `getFunasrMltNanoLanguages()` | `modelOptions.funasrNano.language` |

Each returns `{ id: string; name: string }[]`. Use `id` for the model option, `name` for display.

```typescript
import { getWhisperLanguages } from 'react-native-sherpa-onnx/stt';

const languages = getWhisperLanguages();
// languages[0] => { id: 'en', name: 'english' }
```

---

## Detailed Examples

### Iterate bundled models

```typescript
import { listAssetModels } from 'react-native-sherpa-onnx';
import { createSTT } from 'react-native-sherpa-onnx/stt';

const models = await listAssetModels();
for (const m of models.filter(m => m.hint === 'stt')) {
  try {
    const stt = await createSTT({
      modelPath: { type: 'asset', path: `models/${m.folder}` },
      modelType: 'auto',
      preferInt8: true,
    });
    console.log('Loaded:', m.folder);
    // ... use stt ...
    await stt.destroy();
    break;
  } catch (e) {
    // try next model
  }
}
```

### Whisper with language selection

```typescript
import { createSTT, getWhisperLanguages } from 'react-native-sherpa-onnx/stt';

const languages = getWhisperLanguages();
// Show dropdown: languages[].name, use languages[].id

const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny' },
  modelType: 'whisper',
  modelOptions: { whisper: { language: selectedLanguage.id, task: 'transcribe' } },
});
```

### Transcribe from samples

```typescript
const result = await stt.transcribeSamples(floatSamples, 16000);
console.log(result.text, result.lang, result.tokens);
```

### Runtime config update

```typescript
await stt.setConfig({
  decodingMethod: 'modified_beam_search',
  maxActivePaths: 8,
  hotwordsFile: '/path/to/hotwords.txt',
  hotwordsScore: 2.0,
});
```

### Detect model type before initialization

```typescript
import { detectSttModel } from 'react-native-sherpa-onnx/stt';

const result = await detectSttModel(
  { type: 'asset', path: `models/${selectedFolder}` }
);

if (result.success) {
  console.log('Detected:', result.modelType);
  // Show model-type-specific options in UI
} else {
  console.error('Detection failed:', result.error);
}
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| "Missing required files" | Ensure model directory contains expected files for the detected type |
| Wrong language output | Set `modelOptions.whisper.language` or `senseVoice.language` explicitly |
| Slow transcription | Use `preferInt8: true`, adjust `numThreads` |
| `HOTWORDS_NOT_SUPPORTED` | Hotwords only work with `transducer` / `nemo_transducer` models |
| Poor accuracy | Ensure audio is 16 kHz mono WAV. Use `convertAudioToWav16k()` from `react-native-sherpa-onnx/audio` |
| Content URI (Android) | `transcribeFile()` accepts `content://` URIs (copies to temp file internally) |
| "Cannot auto-detect model type" | Check folder contains required files; try explicit `modelType` |

**Performance tips:**

- Int8 models are faster with minimal accuracy loss — use `preferInt8: true`
- For very long files, consider chunking to avoid memory spikes
- Most models expect 16 kHz mono; resample with `convertAudioToWav16k()` if needed
- Post-processing (punctuation, capitalization) may be needed depending on the model

---

## Native Bridge Mapping

| JS (public) | TurboModule method | Notes |
| --- | --- | --- |
| `createSTT()` | `initializeStt(instanceId, modelDir, ...)` | JS resolves `modelPath`, generates `instanceId` |
| `stt.transcribeFile()` | `transcribeFile(instanceId, filePath)` | — |
| `stt.transcribeSamples()` | `transcribeSamples(instanceId, samples, sampleRate)` | — |
| `stt.setConfig()` | `setSttConfig(instanceId, options)` | Flat options object |
| `stt.destroy()` | `unloadStt(instanceId)` | — |

The JS layer normalizes results via `normalizeSttResult()` so arrays and strings are always the expected shape.

---

## See Also

- [Streaming STT](stt-streaming.md) — Real-time recognition with partial results
- [PCM Live Stream](pcm-live-stream.md) — Microphone capture for streaming STT
- [Hotwords](hotwords.md) — Contextual biasing for transducer models
- [Model Setup](model-setup.md) — Model discovery, paths, and detection
- [Download Manager](download-manager.md) — Download models in-app
- [Execution Providers](execution-providers.md) — QNN, NNAPI, XNNPACK, Core ML
