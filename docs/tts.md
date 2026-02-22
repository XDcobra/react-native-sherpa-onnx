# Text-to-Speech (TTS)

This guide covers the offline TTS APIs shipped with this package and practical examples for streaming playback, saving, and low-latency playback.

## Table of contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Streaming TTS (low-latency)](#streaming-tts-low-latency)
- [Live PCM Playback (native player)](#live-pcm-playback-native-player)
- [API Reference & Practical Notes](#api-reference--practical-notes)
  - [initializeTTS(options)](#initializettsoptions)
  - [updateTtsParams(options)](#updatettsparamsoptions)
  - [generateSpeech(text, options?)](#generatespeechtext-options)
  - [generateSpeechWithTimestamps(text, options?)](#generatespeechwithtimestampstext-options)
  - [generateSpeechStream(text, options?, handlers)](#generatespeechstreamtext-options-handlers)
  - [startTtsPcmPlayer / writeTtsPcmChunk / stopTtsPcmPlayer](#startttspcmplayersamplerate-channels--writettspcmchunksamples--stopttspcmplayer)
  - [Persistence (save/share)](#persistence-saveshare)
  - [Voice cloning (reference audio)](#voice-cloning-reference-audio)
- [Detailed Example: streaming -> native playback -> optional save](#detailed-example-streaming--native-playback--optional-save)
- [Mapping to Native API](#mapping-to-native-api)
  - [TurboModule (spec: src/NativeSherpaOnnx.ts)](#turbomodule-spec-srcnativesherpaonnxts)
- [Model Setup](#model-setup)
- [Troubleshooting & tuning](#troubleshooting--tuning)

| Feature | Status | Source | Notes |
| --- | --- | --- | --- |
| Model type detection (no init) | ✅ | Native | `detectTtsModel(modelPath, options?)` — see [Model Setup: detectSttModel / detectTtsModel](./MODEL_SETUP.md#model-type-detection-without-initialization) |
| Model initialization | ✅ | Kotlin API | `initializeTTS()` |
| Full-buffer generation | ✅ | Kotlin API | `generateSpeech()` |
| Streaming generation | ✅ | Kotlin API | `generateSpeechStream()` |
| Native PCM playback | ✅ | Kotlin API | `startTtsPcmPlayer()` / `writeTtsPcmChunk()` |
| Save/share WAV | ✅ | Kotlin API | `saveAudioToFile()` / `saveAudioToContentUri()` |
| Timestamps (estimated) | ✅ | Kotlin API | `generateSpeechWithTimestamps()` |
| Noise/Noise W/Length scale tuning | ✅ | Kotlin API | VITS/Matcha/Kokoro/Kitten (model-dependent) |
| Runtime param updates | ✅ | Kotlin API | `updateTtsParams()` |
| Model downloads | ✅ | Kotlin API | Download Manager API |
| Voice cloning / reference audio | ✅ | Kotlin API | Integrated in `generateSpeech()` / `generateSpeechStream()` (Zipvoice + GenerationConfig) |
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
  initializeTTS,
  generateSpeech,
  unloadTTS,
} from 'react-native-sherpa-onnx/tts';

await initializeTTS({
  modelPath: {
    type: 'asset',
    path: 'models/sherpa-onnx-vits-piper-en_US-libritts_r-medium',
  },
  modelType: 'auto',
  numThreads: 2,
});

const audio = await generateSpeech('Hello, world!');
console.log('sampleRate:', audio.sampleRate, 'samples:', audio.samples.length);

await unloadTTS();
```

## Streaming TTS (low-latency)

Use streaming mode to receive incremental float PCM chunks and play them immediately.

```typescript
import { generateSpeechStream, cancelSpeechStream } from 'react-native-sherpa-onnx/tts';

const unsubscribe = await generateSpeechStream(
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
await cancelSpeechStream();
unsubscribe();
```

## Live PCM Playback (native player)

The library exposes a native PCM player so you can minimize JS roundtrips and play chunks immediately.

```typescript
import { startTtsPcmPlayer, writeTtsPcmChunk, stopTtsPcmPlayer, getSampleRate } from 'react-native-sherpa-onnx/tts';

const sampleRate = await getSampleRate();
await startTtsPcmPlayer(sampleRate, 1); // mono

// inside onChunk handler from generateSpeechStream:
// await writeTtsPcmChunk(chunk.samples);

await stopTtsPcmPlayer();
```

## API Reference & Practical Notes

### `initializeTTS(options)`

Initialize the text-to-speech engine with a model. `options.modelPath` should point to the model directory using a `ModelPathConfig` (no string path needed). Use `modelType: 'auto'` to let the SDK detect the model based on files, or set it explicitly to `'vits'`, `'matcha'`, `'kokoro'`, `'kitten'`, `'pocket'`, or `'zipvoice'`.
Auto-detection is file-based, so folder names do not need to match model types.

Model-specific options (noise/length scale) go in `modelOptions`; only the block for the loaded model type is applied. See `TtsModelOptions`, `TtsVitsModelOptions`, `TtsMatchaModelOptions`, etc. in `src/tts/types.ts`.

```typescript
// VITS: noiseScale, noiseScaleW, lengthScale
await initializeTTS({
  modelPath,
  modelType: 'vits',
  numThreads: 2,
  modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } },
});

// Kokoro: lengthScale only
await initializeTTS({
  modelPath,
  modelType: 'kokoro',
  modelOptions: { kokoro: { lengthScale: 1.2 } },
});
```

Optional config-level options (OfflineTtsConfig, for text normalization / streaming batch size):

- **ruleFsts** (string) — Path(s) to rule FSTs for TTS (e.g. ITN).
- **ruleFars** (string) — Path(s) to rule FARs for TTS.
- **maxNumSentences** (number, default: 1) — Max number of sentences per streaming callback.
- **silenceScale** (number, default: 0.2) — Silence scale on config level.

### `updateTtsParams(options)`

Update TTS parameters at runtime without reloading the model manually. Pass `modelType` and `modelOptions`; only the block for that model type is applied (same design as init). The JS layer flattens to native `noiseScale` / `noiseScaleW` / `lengthScale`.

```typescript
await updateTtsParams({
  modelType: 'vits',
  modelOptions: { vits: { noiseScale: 0.7, noiseScaleW: 0.8, lengthScale: 1.0 } },
});
```

### `generateSpeech(text, options?)`

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
- Check `getTtsSampleRate()` after initialization to know the model's native sample rate.
- If a model outputs 22050 Hz and your playback path expects 48000 Hz, resample to avoid pitch/tempo mismatch.

### `generateSpeechWithTimestamps(text, options?)`

Same as `generateSpeech` but returns additional `subtitles` and `estimated` (timestamps are estimated from duration when the model does not provide them). Accepts the same `TtsGenerationOptions`, including voice-cloning options.

### `generateSpeechStream(text, options?, handlers)`

Generate speech audio in streaming mode with `onChunk` callbacks. Accepts the same **options** object as `generateSpeech` (sid, speed, and optionally reference audio for Kotlin-engine models).

**Note:** Streaming with reference audio is **not supported for Zipvoice**; use `generateSpeech` for Zipvoice voice cloning. For Kotlin-engine models (e.g. Pocket with GenerationConfig), streaming with reference audio is supported.

Handlers should be lightweight; forward audio to native playback quickly.

Best practices and caveats:
- Chunk sizes vary by model and internal buffer. Avoid heavy CPU work in `onChunk`.
- Accumulating all chunks in JS for very long sessions can exhaust memory — prefer saving on native or writing to a file incrementally.
- To stop generation early, call `cancelSpeechStream()`.

### `startTtsPcmPlayer(sampleRate, channels)` / `writeTtsPcmChunk(samples)` / `stopTtsPcmPlayer()`

Important:
- `writeTtsPcmChunk` expects float PCM samples in [-1.0, 1.0]. Values outside this range will clip.
- Balance write frequency and chunk size: very small writes increase bridge overhead; very large writes increase latency.

### Persistence (save/share)

Use `saveAudioToFile(audio, filePath)` to write a WAV file to an absolute path (`audio` is `{ samples, sampleRate }`). On Android, prefer `saveAudioToContentUri(audio, directoryContentUri, filename)` when writing to user-selected directories (SAF). After saving to SAF, you can call `copyTtsContentUriToCache` to obtain a local copy for playback or sharing.

Android SAF notes:
- `saveTtsAudioToContentUri` accepts a directory content URI and filename and returns a content URI for the saved file. Use the returned URI to share or present to the user.

iOS notes:
- On iOS the native implementation writes into the app container. Use share APIs to export if needed.

### Voice cloning (reference audio)

When the loaded model supports it (Zipvoice or Kotlin engines with GenerationConfig, e.g. Pocket), you can pass reference audio and its transcript so the synthesized speech matches the reference voice:

```typescript
// After loading a Zipvoice or compatible Kotlin model (e.g. Pocket)
const audio = await generateSpeech('Target text to speak in the reference voice', {
  referenceAudio: { samples: refSamples, sampleRate: 22050 },
  referenceText: 'Transcript of the reference recording',
  numSteps: 20,  // optional; model-dependent
  speed: 1.0,
});
// For Pocket you can also pass extra: { temperature: '0.7', chunk_size: '15' }
```

Use `generateSpeech` for Zipvoice with reference audio. Use `generateSpeech` or `generateSpeechStream` for Kotlin-engine models (e.g. Pocket) with reference audio; streaming with reference audio is not available for Zipvoice.

## Detailed Example: streaming -> native playback -> optional save

```typescript
import {
  initializeTTS,
  generateSpeechStream,
  cancelSpeechStream,
  startTtsPcmPlayer,
  writeTtsPcmChunk,
  stopTtsPcmPlayer,
  getTtsSampleRate,
  saveAudioToFile,
} from 'react-native-sherpa-onnx/tts';

await initializeTTS({
  modelPath: {
    type: 'asset',
    path: 'models/sherpa-onnx-vits-piper-en_US-libritts_r-medium',
  },
  numThreads: 2,
});

const sampleRate = await getTtsSampleRate();
await startTtsPcmPlayer(sampleRate, 1);

const accumulated: number[] = [];

const unsub = await generateSpeechStream('Hello world', { sid: 0, speed: 1.0 }, {
  onChunk: async (chunk) => {
    // low-latency play
    await writeTtsPcmChunk(chunk.samples);
    // optionally persist to JS buffer (watch memory)
    accumulated.push(...chunk.samples);
  },
  onEnd: async () => {
    await stopTtsPcmPlayer();
    // optionally save accumulated audio (beware memory for long sessions)
    await saveAudioToFile({ samples: accumulated, sampleRate }, '/data/user/0/.../tts_out.wav');
  },
  onError: ({ message }) => console.warn('TTS stream error', message),
});

// cancel if needed
// await cancelSpeechStream();
// unsub();
```

## Mapping to Native API

The JS API in `react-native-sherpa-onnx/tts` resolves model paths and maps options; prefer it over calling the TurboModule directly.

### TurboModule (spec: `src/NativeSherpaOnnx.ts`)

| JS (public) | TurboModule method | Notes |
| --- | --- | --- |
| `initializeTTS(options)` | `initializeTts(modelDir, modelType, numThreads, debug, noiseScale?, noiseScaleW?, lengthScale?, ruleFsts?, ruleFars?, maxNumSentences?, silenceScale?)` | JS resolves `modelPath` to `modelDir`; builds noiseScale/noiseScaleW/lengthScale from `options.modelOptions` for the given `modelType`. Optional ruleFsts, ruleFars, maxNumSentences, silenceScale (OfflineTtsConfig). |
| `updateTtsParams(options)` | `updateTtsParams(noiseScale?, noiseScaleW?, lengthScale?)` | JS flattens `options.modelType` + `options.modelOptions` to the three native params; only the block for `modelType` is used. |
| `generateSpeech(text, options?)` | `generateTts(text, options)` | Full-buffer generation; `options`: sid, speed, referenceAudio, referenceSampleRate, referenceText, numSteps, silenceScale, extra. |
| `generateSpeechWithTimestamps(text, options?)` | `generateTtsWithTimestamps(text, options)` | Same as above; result includes `subtitles` and `estimated`. |
| `generateSpeechStream(text, options?, handlers)` | `generateTtsStream(text, options)` | Streaming generation (emits chunk events); same options shape. |
| `cancelSpeechStream()` | `cancelTtsStream()` | No arguments. |
| `startTtsPcmPlayer(sampleRate, channels)` | `startTtsPcmPlayer(sampleRate, channels)` | — |
| `writeTtsPcmChunk(samples)` | `writeTtsPcmChunk(samples)` | Float PCM in [-1, 1]. |
| `stopTtsPcmPlayer()` | `stopTtsPcmPlayer()` | — |
| `getSampleRate()` | `getTtsSampleRate()` | — |
| `getNumSpeakers()` | `getTtsNumSpeakers()` | — |
| `unloadTTS()` | `unloadTts()` | No arguments. |
| `saveAudioToFile(audio, filePath)` | `saveTtsAudioToFile(samples, sampleRate, filePath)` | — |
| `saveAudioToContentUri(...)` | `saveTtsAudioToContentUri(...)` | Android SAF; returns content URI. |
| `copyContentUriToCache(fileUri, filename)` | `copyTtsContentUriToCache(fileUri, filename)` | — |

The JS layer converts `TtsGenerationOptions` (e.g. `referenceAudio: { samples, sampleRate }`) into a flat options object for the native bridge. Use the high-level JS helpers in `react-native-sherpa-onnx/tts` where possible — they encapsulate conversions and event wiring.

## Model Setup

See [TTS_MODEL_SETUP.md](./TTS_MODEL_SETUP.md) for model downloads and setup steps.

## Troubleshooting & tuning

- Latency/stuttering: tune native player buffer sizes and write frequency. On Android adjust AudioTrack buffer sizes; on iOS tune AVAudioEngine settings.
- Memory: avoid retaining large arrays in JS for long sessions. Prefer native-side streaming-to-file if you expect long outputs.
- Threading: increase `numThreads` for better throughput on multi-core devices, but test memory usage.
- Quantization: `preferInt8` usually improves speed and memory but can slightly affect voice quality.
- Noise/length scale: smaller `lengthScale` speeds up speech; `noiseScale` and `noiseScaleW` can trade naturalness vs. clarity (model-dependent).
