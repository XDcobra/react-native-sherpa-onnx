# Text-to-Speech (TTS)

This guide covers the offline TTS APIs shipped with this package and practical examples for streaming playback, saving, and low-latency playback.

## Table of contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Streaming TTS (low-latency)](#streaming-tts-low-latency)
- [Live PCM Playback (native player)](#live-pcm-playback-native-player)
- [API Reference & Practical Notes](#api-reference--practical-notes)
  - [createTTS(options)](#createttsoptions)
  - [TtsEngine: updateParams(options)](#ttsengine-updateparamoptions)
  - [TtsEngine: generateSpeech(text, options?)](#ttsengine-generatespeechtext-options)
  - [TtsEngine: generateSpeechWithTimestamps(text, options?)](#ttsengine-generatespeechwithtimestampstext-options)
  - [TtsEngine: generateSpeechStream(text, options?, handlers)](#ttsengine-generatespeechstreamtext-options-handlers)
  - [TtsEngine: startPcmPlayer / writePcmChunk / stopPcmPlayer](#ttsengine-startpcmplayer--writepcmchunk--stoppcmplayer)
  - [Persistence (save/share)](#persistence-saveshare)
  - [Voice cloning (reference audio)](#voice-cloning-reference-audio)
- [Detailed Example: streaming -> native playback -> optional save](#detailed-example-streaming--native-playback--optional-save)
- [Mapping to Native API](#mapping-to-native-api)
  - [TurboModule (spec: src/NativeSherpaOnnx.ts)](#turbomodule-spec-srcnativesherpaonnxts)
- [Model Setup](#model-setup)
- [Troubleshooting & tuning](#troubleshooting--tuning)

| Feature | Status | Source | Notes |
| --- | --- | --- | --- |
| Model type detection (no init) | ✅ | Native | `detectTtsModel(modelPath, options?)` — includes validation of required files; missing files cause `success: false` with specific error (e.g. `"TTS Kokoro: missing required files in …: dataDir"`). Returns `success`, `detectedModels`, `modelType`, and for Kokoro/Kitten multi-lang also `lexiconLanguageCandidates`. See [Model Setup: detectSttModel / detectTtsModel](./MODEL_SETUP.md#model-type-detection-without-initialization). |
| Required-files validation | ✅ | Native | Automatic after detection; see [Validation (required files)](#validation-required-files). |
| Model initialization | ✅ | Kotlin API | `createTTS()` --> `TtsEngine` |
| Full-buffer generation | ✅ | Kotlin API | `tts.generateSpeech()` |
| Streaming generation | ✅ | Kotlin API | `tts.generateSpeechStream()` |
| Native PCM playback | ✅ | Kotlin API | `tts.startPcmPlayer()` / `tts.writePcmChunk()` |
| Save/share WAV | ✅ | Kotlin API | `saveAudioToFile()` / `saveAudioToContentUri()` |
| Save MP3/FLAC to content URI | ✅ | This package | `saveAudioToFile()` → `convertAudioToFormat()` (from `react-native-sherpa-onnx/audio`) → `copyFileToContentUri()`; see [Saving MP3/FLAC to content URI](#saving-mp3flac-to-content-uri-android). |
| Timestamps (estimated) | ✅ | Kotlin API | `generateSpeechWithTimestamps()` |
| Noise/Noise W/Length scale tuning | ✅ | Kotlin API | VITS/Matcha/Kokoro/Kitten (model-dependent) |
| Runtime param updates | ✅ | Kotlin API | `tts.updateParams()` |
| Model downloads | ✅ | Kotlin API | Download Manager API |
| Voice cloning / reference audio | ✅ | Kotlin API | Integrated in `tts.generateSpeech()` / `tts.generateSpeechStream()` (Zipvoice + GenerationConfig) |
| Generate with GenerationConfig | ✅ | Kotlin API | Reference audio, silenceScale, numSteps, extra via options |
| Additional audio formats (MP3/OGG/FLAC) | ✅ | This package | Use the provided conversion API (e.g. `convertAudioToFormat()` from `react-native-sherpa-onnx/audio`); sherpa-onnx natively outputs WAV/PCM only. |
| Progress in streaming callback (0..1) | Planned | C-API | Not exposed in Kotlin API |
| Batch generation | Planned | C-API | C API supports multi-text generation |
| SSML | Planned | C-API | Model-dependent |
| Real-time factor (RTF) | Planned | C-API | Performance metrics |
| Speaker embedding customization | Planned | C-API | Model-dependent |

## Overview

The TTS module supports both full-buffer generation (return the entire sample buffer) and streaming generation (emit incremental PCM chunks). Streaming is useful for low-latency playback and interactive UIs.

All generation functions (`generateSpeech`, `generateSpeechStream`, `generateSpeechWithTimestamps`) accept a single **options** object (`TtsGenerationOptions`). For simple use you pass `sid` and `speed`; for voice cloning you additionally pass `referenceAudio`, `referenceText`, and optionally `numSteps`, `silenceScale`, or `extra` (model-dependent). The native layer uses Kotlin's GenerationConfig or Zipvoice's reference-audio API depending on the loaded model. Supported model types include VITS, Matcha, Kokoro, Kitten, **Pocket**, and Zipvoice (see feature table).

## Quick Start

```typescript
import {
  createTTS,
  saveAudioToFile,
} from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({
  modelPath: {
    type: 'asset',
    path: 'models/sherpa-onnx-vits-piper-en_US-libritts_r-medium',
  },
  modelType: 'auto',
  numThreads: 2,
});

const audio = await tts.generateSpeech('Hello, world!');
console.log('sampleRate:', audio.sampleRate, 'samples:', audio.samples.length);

await tts.destroy();
```

## Streaming TTS (low-latency)

Use streaming mode to receive incremental float PCM chunks and play them immediately.

```typescript
import { createTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits-piper-en' }, modelType: 'vits' });

const unsubscribe = await tts.generateSpeechStream(
  'Hello streaming world!',
  { sid: 0, speed: 1.0 },
  {
    onChunk: (chunk) => {
      // chunk.samples: number[] (Float32 samples)
      // chunk.sampleRate: number
      // chunk.progress: 0..1
      // Best practice: forward chunk.samples immediately to native PCM player
      // to avoid JS buffering and latency.
    },
    onEnd: () => {
      // Stream finished
    },
    onError: ({ message }) => {
      console.warn('Stream error:', message);
    },
  }
);

// cancel generation if needed
await tts.cancelSpeechStream();
unsubscribe();
await tts.destroy();
```

## Live PCM Playback (native player)

The library exposes a native PCM player so you can minimize JS roundtrips and play chunks immediately.

```typescript
import { createTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits-piper-en' }, modelType: 'vits' });

const sampleRate = await tts.getSampleRate();
await tts.startPcmPlayer(sampleRate, 1); // mono

// inside onChunk handler from tts.generateSpeechStream:
// await tts.writePcmChunk(chunk.samples);

await tts.stopPcmPlayer();
await tts.destroy();
```

## API Reference & Practical Notes

### `createTTS(options)`

Create a TTS engine instance. Returns `Promise<TtsEngine>`. You **must** call `tts.destroy()` when done to free native resources.

`options.modelPath` should point to the model directory using a `ModelPathConfig` (no string path needed). Use `modelType: 'auto'` to let the SDK detect the model based on files, or set it explicitly to `'vits'`, `'matcha'`, `'kokoro'`, `'kitten'`, `'pocket'`, or `'zipvoice'`.
Auto-detection is file-based, so folder names do not need to match model types.

Model-specific options (noise/length scale) go in `modelOptions`; only the block for the loaded model type is applied. See `TtsModelOptions`, `TtsVitsModelOptions`, `TtsMatchaModelOptions`, etc. in `src/tts/types.ts`.

```typescript
import { createTTS } from 'react-native-sherpa-onnx/tts';

// VITS: noiseScale, noiseScaleW, lengthScale
const tts = await createTTS({
  modelPath,
  modelType: 'vits',
  numThreads: 2,
  modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } },
});

// Kokoro: lengthScale only
const ttsKokoro = await createTTS({
  modelPath,
  modelType: 'kokoro',
  modelOptions: { kokoro: { lengthScale: 1.2 } },
});
// ... use ttsKokoro ... then await ttsKokoro.destroy();
```

Optional config-level options (OfflineTtsConfig, for text normalization / streaming batch size):

- **ruleFsts** (string) — Path(s) to rule FSTs for TTS (e.g. ITN).
- **ruleFars** (string) — Path(s) to rule FARs for TTS.
- **maxNumSentences** (number, default: 1) — Max number of sentences per streaming callback.
- **silenceScale** (number, default: 0.2) — Silence scale on config level.

### `TtsEngine: updateParams(options)`

Update TTS parameters at runtime without reloading the model. Call on an existing engine: `await tts.updateParams({ modelOptions: { vits: { noiseScale: 0.7 } } })`. Only the block for the effective model type is applied. The engine remembers its model type from creation.

```typescript
// With explicit type
await tts.updateParams({
  modelType: 'vits',
  modelOptions: { vits: { noiseScale: 0.7, noiseScaleW: 0.8, lengthScale: 1.0 } },
});

// Omitting modelType: uses the type from createTTS()
await tts.updateParams({
  modelOptions: { vits: { noiseScale: 0.7, lengthScale: 1.2 } },
});
```

### `TtsEngine: generateSpeech(text, options?)`

Generate speech audio from text. Returns `{ samples: number[]; sampleRate: number }`.

**Options (`TtsGenerationOptions`):**

- `sid` (number, default 0) — Speaker ID for multi-speaker models.
- `speed` (number, default 1.0) — Speech speed multiplier.
- `silenceScale` (number, optional) — Model-dependent (Kotlin GenerationConfig).
- `referenceAudio` (optional) — `{ samples: number[]; sampleRate: number }` for voice cloning (Zipvoice or Kotlin generateWithConfig). Mono float samples in [-1, 1].
- `referenceText` (string, optional) — Transcript of the reference audio; required for voice cloning when `referenceAudio` is set.
- `numSteps` (number, optional) — e.g. flow-matching steps; model-dependent.
- `extra` (Record<string, string>, optional) — Model-specific key-value options (e.g. Pocket: `temperature`, `chunk_size`).

When `referenceAudio` (and typically `referenceText`) are provided, the native layer uses voice cloning: with a Zipvoice model it calls the Zipvoice reference-audio API; with a Kotlin engine (e.g. Pocket, or other models supporting GenerationConfig) it uses `generateWithConfig`.

Tips:
- Check `tts.getSampleRate()` after creation to know the model's native sample rate.
- If a model outputs 22050 Hz and your playback path expects 48000 Hz, resample to avoid pitch/tempo mismatch.

### `TtsEngine: generateSpeechWithTimestamps(text, options?)`

Same as `generateSpeech` but returns additional `subtitles` and `estimated` (timestamps are estimated from duration when the model does not provide them). Accepts the same `TtsGenerationOptions`, including voice-cloning options.

### `TtsEngine: generateSpeechStream(text, options?, handlers)`

Generate speech audio in streaming mode with `onChunk` callbacks. Accepts the same **options** object as `generateSpeech` (sid, speed, and optionally reference audio for Kotlin-engine models).

**Note:** Streaming with reference audio is **not supported for Zipvoice**; use `generateSpeech` for Zipvoice voice cloning. For Kotlin-engine models (e.g. Pocket with GenerationConfig), streaming with reference audio is supported.

Handlers should be lightweight; forward audio to native playback quickly.

Best practices and caveats:
- Chunk sizes vary by model and internal buffer. Avoid heavy CPU work in `onChunk`.
- Accumulating all chunks in JS for very long sessions can exhaust memory — prefer saving on native or writing to a file incrementally.
- To stop generation early, call `tts.cancelSpeechStream()`.

### `TtsEngine: startPcmPlayer` / `writePcmChunk` / `stopPcmPlayer`

Important:
- `tts.writePcmChunk` expects float PCM samples in [-1.0, 1.0]. Values outside this range will clip.
- Balance write frequency and chunk size: very small writes increase bridge overhead; very large writes increase latency.

### Persistence (save/share)

Use `saveAudioToFile(audio, filePath)` to write a WAV file to an absolute path (`audio` is `{ samples, sampleRate }`). On Android, prefer `saveAudioToContentUri(audio, directoryContentUri, filename)` when writing to user-selected directories (SAF). After saving to SAF, you can call `copyTtsContentUriToCache` to obtain a local copy for playback or sharing.

**Saving MP3/FLAC to content URI (Android)**  
`saveAudioToContentUri` only writes WAV. To save MP3 or FLAC into a user-picked folder (content URI):

1. Save WAV to a temp path (e.g. app cache): `saveAudioToFile(audio, tempWavPath)`.
2. Convert to the target format with `convertAudioToFormat(tempWavPath, targetPath, 'mp3' | 'flac')` from `react-native-sherpa-onnx/audio`.
3. Copy the converted file into the SAF directory: `copyFileToContentUri(convertedFilePath, directoryUri, filename, mimeType)` from `react-native-sherpa-onnx/tts` (Android only). Use `audio/mpeg` for MP3 and `audio/flac` for FLAC.
4. Delete the temp WAV and converted files. On conversion failure, fall back to `saveAudioToContentUri(audio, directoryUri, fallbackWavFilename)`.

`copyFileToContentUri(filePath, directoryUri, filename, mimeType)` is format-agnostic: it copies any local file into a document created under the given SAF directory URI and returns the new content URI. On iOS it is not supported (stub rejects).

Android SAF notes:
- `saveTtsAudioToContentUri` accepts a directory content URI and filename and returns a content URI for the saved file. Use the returned URI to share or present to the user.

iOS notes:
- On iOS the native implementation writes into the app container. Use share APIs to export if needed. `copyFileToContentUri` is not available on iOS.

### Voice cloning (reference audio)

When the loaded model supports it (Zipvoice or Kotlin engines with GenerationConfig, e.g. Pocket), you can pass reference audio and its transcript so the synthesized speech matches the reference voice:

```typescript
// After creating a TTS engine with Zipvoice or compatible Kotlin model (e.g. Pocket)
const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/zipvoice' }, modelType: 'zipvoice' });
const audio = await tts.generateSpeech('Target text to speak in the reference voice', {
  referenceAudio: { samples: refSamples, sampleRate: 22050 },
  referenceText: 'Transcript of the reference recording',
  numSteps: 20,  // optional; model-dependent
  speed: 1.0,
});
// For Pocket you can also pass extra: { temperature: '0.7', chunk_size: '15' }
await tts.destroy();
```

Use `tts.generateSpeech` for Zipvoice with reference audio. Use `tts.generateSpeech` or `tts.generateSpeechStream` for Kotlin-engine models (e.g. Pocket) with reference audio; streaming with reference audio is not available for Zipvoice.

## Detailed Example: streaming -> native playback -> optional save

This example shows streaming generation, native PCM playback, and several save options. Use the one that matches where the user wants the file and which format (WAV vs MP3/FLAC) they need.

```typescript
import {
  createTTS,
  saveAudioToFile,
  saveAudioToContentUri,
  copyFileToContentUri,
} from 'react-native-sherpa-onnx/tts';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';
import { CachesDirectoryPath } from '@dr.pogodin/react-native-fs'; // or your FS module

const tts = await createTTS({
  modelPath: {
    type: 'asset',
    path: 'models/sherpa-onnx-vits-piper-en_US-libritts_r-medium',
  },
  numThreads: 2,
});

const sampleRate = await tts.getSampleRate();
await tts.startPcmPlayer(sampleRate, 1);

const accumulated: number[] = [];

const unsub = await tts.generateSpeechStream('Hello world', { sid: 0, speed: 1.0 }, {
  onChunk: async (chunk) => {
    await tts.writePcmChunk(chunk.samples);
    accumulated.push(...chunk.samples);
  },
  onEnd: async () => {
    await tts.stopPcmPlayer();
    const audio = { samples: accumulated, sampleRate };

    // --- Save option A: WAV to app-private path (cache/documents) ---
    // Where: e.g. CachesDirectoryPath or DocumentDirectoryPath (app-only, not user-visible in file picker).
    // When useful: temporary file, internal playback, or when you later convert and move the file yourself.
    const wavPath = `${CachesDirectoryPath}/tts_${Date.now()}.wav`;
    await saveAudioToFile(audio, wavPath);

    // --- Save option B: WAV to user-picked folder (Android SAF) ---
    // Where: user-selected directory via Storage Access Framework; returns a content:// URI.
    // When useful: "Save to folder" with WAV format; user explicitly chose the destination.
    // const directoryUri = 'content://...'; // from DocumentPicker or similar
    // const uri = await saveAudioToContentUri(audio, directoryUri, `tts_${Date.now()}.wav`);

    // --- Save option C: MP3/FLAC to user-picked folder (Android SAF) ---
    // Where: same as B, but file is MP3 or FLAC. Requires temp WAV -> convert -> copy to content URI.
    // When useful: "Save to folder" with MP3 or FLAC; smaller files or compatibility with music players.
    // const ext = 'mp3';
    // const tempWav = `${CachesDirectoryPath}/tts_${Date.now()}.wav`;
    // const tempOut = `${CachesDirectoryPath}/tts_${Date.now()}.${ext}`;
    // await saveAudioToFile(audio, tempWav);
    // await convertAudioToFormat(tempWav, tempOut, ext);
    // const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/flac';
    // await copyFileToContentUri(tempOut, directoryUri, `tts_${Date.now()}.${ext}`, mime);
    // await unlink(tempWav); await unlink(tempOut);

    await tts.destroy();
  },
  onError: ({ message }) => console.warn('TTS stream error', message),
});
```

## Mapping to Native API

The JS API in `react-native-sherpa-onnx/tts` resolves model paths and maps options; prefer it over calling the TurboModule directly.

### TurboModule (spec: `src/NativeSherpaOnnx.ts`)

| JS (public) | TurboModule method | Notes |
| --- | --- | --- |
| `createTTS(options)` | `initializeTts(instanceId, modelDir, ...)` | JS generates `instanceId`, resolves `modelPath` to `modelDir`; builds noiseScale/noiseScaleW/lengthScale from `options.modelOptions`. Returns `TtsEngine` with bound `instanceId`. |
| `tts.updateParams(options)` | `updateTtsParams(instanceId, ...)` | JS flattens `options.modelOptions`; only the block for the engine's model type is used. |
| `tts.generateSpeech(text, options?)` | `generateTts(instanceId, text, options)` | Full-buffer generation; `options`: sid, speed, referenceAudio, referenceSampleRate, referenceText, numSteps, silenceScale, extra. |
| `tts.generateSpeechWithTimestamps(text, options?)` | `generateTtsWithTimestamps(instanceId, text, options)` | Same as above; result includes `subtitles` and `estimated`. |
| `tts.generateSpeechStream(text, options?, handlers)` | `generateTtsStream(instanceId, text, options)` | Streaming generation (emits chunk events with `instanceId`); same options shape. |
| `tts.cancelSpeechStream()` | `cancelTtsStream(instanceId)` | — |
| `tts.startPcmPlayer(sampleRate, channels)` | `startTtsPcmPlayer(instanceId, sampleRate, channels)` | — |
| `tts.writePcmChunk(samples)` | `writeTtsPcmChunk(instanceId, samples)` | Float PCM in [-1, 1]. |
| `tts.stopPcmPlayer()` | `stopTtsPcmPlayer(instanceId)` | — |
| `tts.getSampleRate()` | `getTtsSampleRate(instanceId)` | — |
| `tts.getNumSpeakers()` | `getTtsNumSpeakers(instanceId)` | — |
| `tts.destroy()` | `unloadTts(instanceId)` | Mandatory cleanup. |
| `saveAudioToFile(audio, filePath)` | `saveTtsAudioToFile(samples, sampleRate, filePath)` | Stateless; no instanceId. |
| `saveAudioToContentUri(...)` | `saveTtsAudioToContentUri(...)` | Android SAF; WAV only; returns content URI. |
| `copyFileToContentUri(filePath, directoryUri, filename, mimeType)` | `copyFileToContentUri(...)` | Android only. Copy any local file into SAF directory; use for MP3/FLAC after conversion. |
| `copyContentUriToCache(fileUri, filename)` | `copyTtsContentUriToCache(fileUri, filename)` | — |

The JS layer converts `TtsGenerationOptions` (e.g. `referenceAudio: { samples, sampleRate }`) into a flat options object for the native bridge. Use the high-level JS helpers in `react-native-sherpa-onnx/tts` where possible — they encapsulate conversions and event wiring.

## Model Setup

See [TTS_MODEL_SETUP.md](./TTS_MODEL_SETUP.md) for model downloads and setup steps.

### Zipvoice: full vs distill

- **Full Zipvoice** (supported): encoder + decoder + **vocoder** (e.g. `vocos_24khz.onnx`), plus `tokens.txt`, `lexicon.txt`, and `espeak-ng-data`. The pipeline is: encoder/decoder --> mel-spectrogram --> vocoder --> waveform.
- **Zipvoice distill** (encoder + decoder only, no vocoder): These models are **detected** as zipvoice so they appear in the model list, but **initialization will fail** with a clear error. The sherpa-onnx C-API and C++ implementation require a vocoder; there is no optional-vocoder or waveform-from-decoder path in the current upstream. Use a full Zipvoice model that includes a vocoder file (e.g. `vocos_24khz.onnx`) for successful initialization.

**Memory and model variants:** The full fp32 Zipvoice model (e.g. `sherpa-onnx-zipvoice-zh-en-emilia`, ~605 MB compressed) uses significant RAM when loading. On devices with **less than 8 GB RAM**, prefer the **int8 distill** variant: `sherpa-onnx-zipvoice-distill-int8-zh-en-emilia` (~104 MB compressed). The SDK checks free memory before loading Zipvoice and rejects with an actionable error if below ~800 MB; the error message suggests using the int8 variant or closing other apps.

**References (Zipvoice via sherpa-onnx):**

- [sherpa-onnx PR #2487 – Add Zipvoice](https://github.com/k2-fsa/sherpa-onnx/pull/2487): Integration of Zipvoice (zero-shot TTS, encoder + flow-matching decoder + vocoder), C-API, vocoder selection, and [discussion on running Zipvoice / distill](https://github.com/k2-fsa/sherpa-onnx/pull/2487#issuecomment-3227884498).
- [k2-fsa/ZipVoice](https://github.com/k2-fsa/ZipVoice): Upstream ZipVoice and ZipVoice-Distill (faster, minimal quality loss). For CPU deployment with ONNX, sherpa-onnx is the recommended C++ runtime; the ONNX export for sherpa-onnx still uses encoder + decoder + vocoder (e.g. `vocos_24khz.onnx`).

### Validation (required files)

After detecting the TTS model type, the SDK automatically validates that all **required** file paths for the detected type are present. If any are missing, detection fails with a specific error listing the missing fields. This prevents app crashes during initialization when a model directory is incomplete (e.g. Kokoro without `espeak-ng-data`).

**When it runs:** Automatically as part of `detectTtsModel()` and `createTTS()`. No separate call needed.

**What it checks per model type:**

| Model type | Required | Optional |
| --- | --- | --- |
| **VITS** | `ttsModel`, `tokens` | `dataDir` (espeak-ng-data), `lexicon` |
| **Matcha** | `acousticModel`, `vocoder`, `tokens` | `dataDir`, `lexicon` |
| **Kokoro / Kitten** | `ttsModel`, `tokens`, `voices`, `dataDir` (espeak-ng-data) | `lexicon` |
| **Pocket** | `lmFlow`, `lmMain`, `encoder`, `decoder`, `textConditioner`, `vocabJson`, `tokenScoresJson` | — |
| **Zipvoice** | `encoder`, `decoder`, `vocoder`, `tokens` | `dataDir`, `lexicon` |

**Error format:**

```
TTS <ModelType>: missing required files in <modelDir>: <field1>, <field2>
```

Example: `TTS Kokoro: missing required files in /data/models/kokoro-v1.0: dataDir (Copy espeak-ng-data into the model directory.), voices`

## Troubleshooting & tuning

- **Kokoro/Kitten init fails with "missing required files: dataDir":** The model directory is missing the `espeak-ng-data` folder. Copy or extract `espeak-ng-data` into the model directory. The SDK validates this before initialization and returns a clear error instead of crashing.
- **Zipvoice init fails or app crashes on low-RAM devices (Android):** The full Zipvoice model needs substantial free memory. If you see "Not enough free memory" or a crash in system graphics threads (e.g. `FenceMonitor` / `libgui.so`), use the **int8 distill** model `sherpa-onnx-zipvoice-distill-int8-zh-en-emilia` or close other apps to free RAM.
- Latency/stuttering: tune native player buffer sizes and write frequency. On Android adjust AudioTrack buffer sizes; on iOS tune AVAudioEngine settings.
- Memory: avoid retaining large arrays in JS for long sessions. Prefer native-side streaming-to-file if you expect long outputs.
- Threading: increase `numThreads` for better throughput on multi-core devices, but test memory usage.
- Quantization: `preferInt8` usually improves speed and memory but can slightly affect voice quality.
- Noise/length scale: smaller `lengthScale` speeds up speech; `noiseScale` and `noiseScaleW` can trade naturalness vs. clarity (model-dependent).
