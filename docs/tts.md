# Text-to-Speech (TTS)

Offline text-to-speech: generate speech audio from text using on-device models. Supports full-buffer and streaming generation, native PCM playback, and voice cloning.

**Import path:** `react-native-sherpa-onnx/tts`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [createTTS()](#createttsoptions)
  - [detectTtsModel()](#detectttsmodelmodelpath-options)
  - [TtsEngine](#ttsengine)
  - [TtsGenerationOptions](#ttsgenerationoptions)
  - [GeneratedAudio](#generatedaudio)
  - [Persistence (Save/Share)](#persistence-saveshare)
  - [Types & Constants](#types--constants)
- [Streaming TTS](#streaming-tts)
- [Native PCM Playback](#native-pcm-playback)
- [Voice Cloning](#voice-cloning)
- [Model-Specific Options](#model-specific-options)
  - [Validation (Required Files)](#validation-required-files)
  - [Zipvoice Notes](#zipvoice-notes)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [Native Bridge Mapping](#native-bridge-mapping)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| Model type detection | ✅ | `detectTtsModel()` — file-based, includes required-files validation |
| Model initialization | ✅ | `createTTS()` → `TtsEngine` |
| Full-buffer generation | ✅ | `tts.generateSpeech()` |
| Streaming generation | ✅ | `tts.generateSpeechStream()` with chunk callbacks |
| Timestamps (estimated) | ✅ | `tts.generateSpeechWithTimestamps()` |
| Native PCM playback | ✅ | `startPcmPlayer()` / `writePcmChunk()` / `stopPcmPlayer()` |
| Save/share WAV | ✅ | `saveAudioToFile()` / `saveAudioToContentUri()` |
| Save MP3/FLAC | ✅ | Via `convertAudioToFormat()` + `copyFileToContentUri()` |
| Voice cloning | ✅ | Reference audio via `TtsGenerationOptions` (Zipvoice, Pocket) |
| Runtime param updates | ✅ | `tts.updateParams()` |
| Model downloads | ✅ | Via [Download Manager](download-manager.md) |

Supported model types: `vits`, `matcha`, `kokoro`, `kitten`, `pocket`, `zipvoice`, `auto`.

---

## Quick Start

```typescript
import { createTTS, saveAudioToFile } from 'react-native-sherpa-onnx/tts';

// 1) Create TTS engine
const tts = await createTTS({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-vits-piper-en' },
  modelType: 'auto',
  numThreads: 2,
});

// 2) Generate speech
const audio = await tts.generateSpeech('Hello, world!');
console.log('sampleRate:', audio.sampleRate, 'samples:', audio.samples.length);

// 3) Save to file
await saveAudioToFile(audio, '/path/to/output.wav');

// 4) Cleanup
await tts.destroy();
```

---

## API Reference

### `createTTS(options)`

```ts
function createTTS(
  options: TTSInitializeOptions | ModelPathConfig
): Promise<TtsEngine>;
```

Create a TTS engine instance. You **must** call `tts.destroy()` when done.

**Options (`TTSInitializeOptions`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `modelPath` | `ModelPathConfig` | — | `{ type: 'asset' \| 'file' \| 'auto', path }` |
| `modelType` | `TTSModelType` | `'auto'` | `'vits'`, `'matcha'`, `'kokoro'`, `'kitten'`, `'pocket'`, `'zipvoice'`, or `'auto'` |
| `numThreads` | `number` | `1` | Inference threads |
| `provider` | `string` | — | `'cpu'`, `'coreml'`, etc. See [execution-providers.md](execution-providers.md) |
| `debug` | `boolean` | `false` | Debug logging |
| `modelOptions` | `TtsModelOptions` | — | Per-model options (noise/length scale). See [Model-Specific Options](#model-specific-options) |
| `ruleFsts` | `string` | — | Rule FST paths for text normalization |
| `ruleFars` | `string` | — | Rule FAR paths |
| `maxNumSentences` | `number` | `1` | Max sentences per streaming callback |
| `silenceScale` | `number` | `0.2` | Config-level silence scale |

---

### `detectTtsModel(modelPath, options?)`

```ts
function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  lexiconLanguageCandidates?: string[];
}>;
```

Detect model type without loading. Includes required-files validation. For **Kokoro/Kitten** models with multiple lexicon files, returns `lexiconLanguageCandidates` (e.g. `["gb-en", "us-en", "zh"]`).

```typescript
const result = await detectTtsModel({ type: 'file', path: fullPathToKokoro });
if (result.success && result.lexiconLanguageCandidates?.length) {
  // Show language dropdown for Kokoro/Kitten
}
```

---

### `TtsEngine`

Returned by `createTTS()`. Call `destroy()` when done.

| Method | Signature | Description |
| --- | --- | --- |
| `instanceId` | `string` (read-only) | Engine instance ID |
| `generateSpeech` | `(text: string, options?: TtsGenerationOptions) => Promise<GeneratedAudio>` | Full-buffer generation |
| `generateSpeechWithTimestamps` | `(text: string, options?: TtsGenerationOptions) => Promise<GeneratedAudioWithTimestamps>` | Full-buffer with subtitles and estimated timestamps |
| `generateSpeechStream` | `(text: string, options?: TtsGenerationOptions, handlers: TtsStreamHandlers) => Promise<TtsStreamController>` | Streaming generation with chunk callbacks |
| `cancelSpeechStream` | `() => Promise<void>` | Cancel current stream |
| `updateParams` | `(options: TtsUpdateOptions) => Promise<void>` | Update params at runtime without reloading |
| `startPcmPlayer` | `(sampleRate: number, channels: number) => Promise<void>` | Start native PCM playback |
| `writePcmChunk` | `(samples: number[]) => Promise<void>` | Write float PCM samples to player |
| `stopPcmPlayer` | `() => Promise<void>` | Stop PCM player |
| `getSampleRate` | `() => Promise<number>` | Model's native sample rate |
| `getNumSpeakers` | `() => Promise<number>` | Number of available speakers |
| `destroy` | `() => Promise<void>` | Release native resources (**mandatory**) |

---

### `TtsGenerationOptions`

Shared by `generateSpeech`, `generateSpeechWithTimestamps`, and `generateSpeechStream`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sid` | `number` | `0` | Speaker ID for multi-speaker models |
| `speed` | `number` | `1.0` | Speech speed multiplier |
| `silenceScale` | `number` | — | Silence scale at generation time |
| `referenceAudio` | `{ samples: number[]; sampleRate: number }` | — | For voice cloning. Mono float samples in [-1, 1] |
| `referenceText` | `string` | — | Transcript of reference audio (required with `referenceAudio`) |
| `numSteps` | `number` | — | Flow-matching steps (model-dependent) |
| `extra` | `Record<string, string>` | — | Model-specific key-value options (e.g. Pocket: `temperature`, `chunk_size`) |

---

### `GeneratedAudio`

| Field | Type | Description |
| --- | --- | --- |
| `samples` | `number[]` | Float PCM samples in [-1, 1] |
| `sampleRate` | `number` | Sample rate in Hz |

`GeneratedAudioWithTimestamps` extends this with `subtitles: TtsSubtitleItem[]` and `estimated: boolean`.

---

### Persistence (Save/Share)

| Function | Description |
| --- | --- |
| `saveAudioToFile(audio, filePath)` | Save WAV to an absolute path |
| `saveAudioToContentUri(audio, directoryUri, filename)` | Save WAV to Android SAF directory (returns content URI) |
| `saveTextToContentUri(text, directoryUri, filename, mimeType?)` | Save text to Android SAF directory |
| `copyFileToContentUri(filePath, directoryUri, filename, mimeType)` | Copy any local file to SAF (Android only; use for MP3/FLAC after conversion) |
| `copyContentUriToCache(fileUri, filename)` | Copy a content URI to app cache (for playback/sharing) |
| `shareAudioFile(fileUri, mimeType?)` | Share an audio file via system share sheet |

**Saving MP3/FLAC to content URI (Android):**

1. Save WAV to temp: `saveAudioToFile(audio, tempWavPath)`
2. Convert: `convertAudioToFormat(tempWavPath, tempOutPath, 'mp3')` (from `react-native-sherpa-onnx/audio`)
3. Copy to SAF: `copyFileToContentUri(tempOutPath, directoryUri, filename, 'audio/mpeg')`
4. Delete temp files

---

### Types & Constants

```ts
import {
  createTTS,
  detectTtsModel,
  saveAudioToFile,
  saveAudioToContentUri,
  copyFileToContentUri,
  copyContentUriToCache,
  shareAudioFile,
} from 'react-native-sherpa-onnx/tts';

import type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TtsGenerationOptions,
  GeneratedAudio,
  GeneratedAudioWithTimestamps,
  TtsSubtitleItem,
  TtsEngine,
  TtsUpdateOptions,
} from 'react-native-sherpa-onnx/tts';
```

- **`TTS_MODEL_TYPES`:** `['vits', 'matcha', 'kokoro', 'kitten', 'pocket', 'zipvoice', 'auto']`

---

## Streaming TTS

Generate speech incrementally and receive audio chunks as they are produced.

```typescript
const controller = await tts.generateSpeechStream(
  'Hello, streaming world!',
  { sid: 0, speed: 1.0 },
  {
    onChunk: (chunk) => {
      // chunk.samples, chunk.sampleRate, chunk.progress (0..1), chunk.isFinal
    },
    onEnd: (event) => {
      // event.cancelled: boolean
    },
    onError: (event) => {
      console.warn(event.message);
    },
  }
);

// Cancel if needed
await controller.cancel();
// Or just unsubscribe
controller.unsubscribe();
```

Only one stream per engine can run at a time. For more details, see [tts-streaming.md](tts-streaming.md).

---

## Native PCM Playback

Minimize JS roundtrips by using the built-in native PCM player:

```typescript
const sampleRate = await tts.getSampleRate();
await tts.startPcmPlayer(sampleRate, 1); // mono

const controller = await tts.generateSpeechStream(text, undefined, {
  onChunk: (chunk) => {
    if (chunk.samples.length > 0) tts.writePcmChunk(chunk.samples);
  },
  onEnd: () => tts.stopPcmPlayer(),
  onError: () => tts.stopPcmPlayer(),
});
```

- `writePcmChunk` expects float PCM in [-1.0, 1.0]
- Balance write frequency and chunk size for optimal latency vs. overhead

---

## Voice Cloning

For models that support it (Zipvoice, Pocket with GenerationConfig), pass reference audio:

```typescript
const audio = await tts.generateSpeech('Text in the reference voice', {
  referenceAudio: { samples: refSamples, sampleRate: 22050 },
  referenceText: 'Transcript of the reference recording',
  numSteps: 20,
  speed: 1.0,
});
```

- **Zipvoice:** Use `generateSpeech()` only (streaming with reference audio is not supported)
- **Pocket/Kotlin engines:** Both `generateSpeech()` and `generateSpeechStream()` support reference audio
- Pocket-specific: `extra: { temperature: '0.7', chunk_size: '15' }`

---

## Model-Specific Options

Pass via `modelOptions` in `createTTS()` or `tts.updateParams()`. Only the block for the loaded model type is applied.

| Model | Key | Options |
| --- | --- | --- |
| **VITS** | `vits` | `noiseScale?`, `noiseScaleW?`, `lengthScale?` |
| **Matcha** | `matcha` | `noiseScale?`, `noiseScaleW?`, `lengthScale?` |
| **Kokoro** | `kokoro` | `lengthScale?` |
| **Kitten** | `kitten` | `lengthScale?` |
| **Pocket** | `pocket` | *(no scale options)* |

```typescript
const tts = await createTTS({
  modelPath,
  modelType: 'vits',
  modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } },
});

// Update at runtime
await tts.updateParams({
  modelOptions: { vits: { noiseScale: 0.7, lengthScale: 1.2 } },
});
```

### Validation (Required Files)

After detection, the SDK validates all required files are present.

| Model Type | Required | Optional |
| --- | --- | --- |
| **VITS** | `ttsModel`, `tokens` | `dataDir`, `lexicon` |
| **Matcha** | `acousticModel`, `vocoder`, `tokens` | `dataDir`, `lexicon` |
| **Kokoro / Kitten** | `ttsModel`, `tokens`, `voices`, `dataDir` (espeak-ng-data) | `lexicon` |
| **Pocket** | `lmFlow`, `lmMain`, `encoder`, `decoder`, `textConditioner`, `vocabJson`, `tokenScoresJson` | — |
| **Zipvoice** | `encoder`, `decoder`, `vocoder`, `tokens` | `dataDir`, `lexicon` |

Error format: `TTS <ModelType>: missing required files in <modelDir>: <field1>, <field2>`

### Zipvoice Notes

- **Full Zipvoice** (encoder + decoder + vocoder, e.g. `vocos_24khz.onnx`): supported
- **Zipvoice distill** (no vocoder): detected but **initialization fails** — sherpa-onnx requires a vocoder
- **Memory:** Full fp32 model (~605 MB) uses significant RAM. On devices with < 8 GB, prefer the **int8 distill** variant (~104 MB). The SDK rejects with an actionable error if free memory is below ~800 MB

---

## Detailed Examples

### Streaming → native playback → save

```typescript
import { createTTS, saveAudioToFile } from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({
  modelPath: { type: 'asset', path: 'models/vits-piper-en' },
  numThreads: 2,
});

const sampleRate = await tts.getSampleRate();
await tts.startPcmPlayer(sampleRate, 1);

const accumulated: number[] = [];

await tts.generateSpeechStream('Hello world', { sid: 0 }, {
  onChunk: async (chunk) => {
    await tts.writePcmChunk(chunk.samples);
    accumulated.push(...chunk.samples);
  },
  onEnd: async () => {
    await tts.stopPcmPlayer();
    await saveAudioToFile(
      { samples: accumulated, sampleRate },
      `${CachesDirectoryPath}/tts_${Date.now()}.wav`
    );
  },
  onError: ({ message }) => console.warn(message),
});

await tts.destroy();
```

### Multi-speaker

```typescript
const numSpeakers = await tts.getNumSpeakers();
const audio = await tts.generateSpeech('Hello', { sid: 3, speed: 1.2 });
```

### Detect model type before init

```typescript
import { detectTtsModel } from 'react-native-sherpa-onnx/tts';

const result = await detectTtsModel({ type: 'file', path: fullPath });
if (result.success && result.modelType === 'kokoro') {
  // Show kokoro-specific options
  // result.lexiconLanguageCandidates — use for language dropdown
}
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| "Missing required files" | Check model directory for expected files per model type |
| Pitch/tempo mismatch | Sample rate mismatch — check `tts.getSampleRate()` and match playback rate |
| Zipvoice init fails | Use full model with vocoder (e.g. `vocos_24khz.onnx`), not distill |
| Zipvoice OOM | Use int8 distill variant on low-RAM devices |
| `TTS_STREAM_ERROR` | Only one stream per engine at a time. Wait for `onEnd` or `cancel()` first |
| No sound from PCM player | Ensure `startPcmPlayer()` called before `writePcmChunk()`, stop after done |
| `copyFileToContentUri` fails on iOS | Android SAF only; not supported on iOS |

**Performance tips:**

- Use streaming for lower time-to-first-byte
- Use native PCM player instead of JS-side audio playback
- Kokoro/Kitten: only `lengthScale` applies
- VITS/Matcha: tune `noiseScale`, `noiseScaleW`, `lengthScale` for quality vs. speed

---

## Native Bridge Mapping

| JS (public) | TurboModule method | Notes |
| --- | --- | --- |
| `createTTS()` | `initializeTts(instanceId, modelDir, ...)` | JS resolves `modelPath`, generates `instanceId` |
| `tts.generateSpeech()` | `generateTts(instanceId, text, options)` | — |
| `tts.generateSpeechWithTimestamps()` | `generateTtsWithTimestamps(instanceId, text, options)` | — |
| `tts.generateSpeechStream()` | `generateTtsStream(instanceId, text, options)` | Events: `ttsStreamChunk`, `ttsStreamEnd`, `ttsStreamError` |
| `tts.cancelSpeechStream()` | `cancelTtsStream(instanceId)` | — |
| `tts.updateParams()` | `updateTtsParams(instanceId, ...)` | — |
| `tts.startPcmPlayer()` | `startTtsPcmPlayer(instanceId, sampleRate, channels)` | — |
| `tts.writePcmChunk()` | `writeTtsPcmChunk(instanceId, samples)` | — |
| `tts.stopPcmPlayer()` | `stopTtsPcmPlayer(instanceId)` | — |
| `tts.getSampleRate()` | `getTtsSampleRate(instanceId)` | — |
| `tts.getNumSpeakers()` | `getTtsNumSpeakers(instanceId)` | — |
| `tts.destroy()` | `unloadTts(instanceId)` | — |
| `saveAudioToFile()` | `saveTtsAudioToFile(samples, sampleRate, filePath)` | Stateless |
| `saveAudioToContentUri()` | `saveTtsAudioToContentUri(...)` | Android SAF; WAV only |
| `copyFileToContentUri()` | `copyFileToContentUri(...)` | Android only |

---

## See Also

- [Streaming TTS](tts-streaming.md) — Detailed streaming generation API
- [Model Setup](model-setup.md) — Model discovery, paths, and detection
- [Download Manager](download-manager.md) — Download models in-app
- [Audio Conversion](audio-conversion.md) — Convert audio formats (MP3, FLAC, WAV)
- [Execution Providers](execution-providers.md) — QNN, NNAPI, XNNPACK, Core ML
