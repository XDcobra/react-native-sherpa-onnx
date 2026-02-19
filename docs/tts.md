# Text-to-Speech (TTS)

This guide covers the offline TTS APIs shipped with this package and practical examples for streaming playback, saving, and low-latency playback.

| Feature | Status | Source | Notes |
| --- | --- | --- | --- |
| Model initialization | Supported | Kotlin API | `initializeTTS()` |
| Full-buffer generation | Supported | Kotlin API | `generateSpeech()` |
| Streaming generation | Supported | Kotlin API | `generateSpeechStream()` |
| Native PCM playback | Supported | Kotlin API | `startTtsPcmPlayer()` / `writeTtsPcmChunk()` |
| Save/share WAV | Supported | Kotlin API | `saveAudioToFile()` / `saveAudioToContentUri()` |
| Timestamps (estimated) | Supported | Kotlin API | `generateSpeechWithTimestamps()` |
| Noise/Noise W/Length scale tuning | Supported | Kotlin API | VITS/Matcha/Kokoro/Kitten (model-dependent) |
| Runtime param updates | Supported | Kotlin API | `updateTtsParams()` |
| Model downloads | Supported | Kotlin API | Download Manager API |
| Voice cloning / reference audio | Supported | Kotlin API | Integrated in `generateSpeech()` / `generateSpeechStream()` (Zipvoice + GenerationConfig) |
| Generate with GenerationConfig | Supported | Kotlin API | Reference audio, silenceScale, numSteps, extra via options |
| Pocket-TTS model type | Supported | Kotlin API | `modelType: 'pocket'` |
| Progress in streaming callback (0..1) | Planned | C-API | Not exposed in Kotlin API |
| Batch generation | Planned | C-API | C API supports multi-text generation |
| SSML | Planned | C-API | Model-dependent |
| Real-time factor (RTF) | Planned | C-API | Performance metrics |
| Speaker embedding customization | Planned | C-API | Model-dependent |
| Additional audio formats | Planned | C-API | MP3/OGG/FLAC export |

## Overview

The TTS module supports both full-buffer generation (return the entire sample buffer) and streaming generation (emit incremental PCM chunks). Streaming is useful for low-latency playback and interactive UIs.

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

Initialize the text-to-speech engine with a model. `options.modelPath` should point to the model directory using a `ModelPathConfig` (no string path needed). Use `modelType: 'auto'` to let the SDK detect the model based on files.
Auto-detection is file-based, so folder names do not need to match model types.

Noise/Noise W/Length scale tuning (model-dependent):

```typescript
await initializeTTS({
  modelPath,
  numThreads: 2,
  noiseScale: 0.667,
  noiseScaleW: 0.8,
  lengthScale: 1.0,
});
```

### `updateTtsParams(options)`

Update TTS parameters at runtime without reloading the model manually. Pass `null` to reset a parameter to the model default; omit a field to keep the current value.

```typescript
await updateTtsParams({
  noiseScale: 0.7,
  noiseScaleW: 0.8,
  lengthScale: null,
});
```

### `generateSpeech(text, options?)`

Generate speech audio from text. Returns `{ samples: number[]; sampleRate: number }`.

Tips:
- Check `getTtsSampleRate()` after initialization to know the model's native sample rate.
- If a model outputs 22050 Hz and your playback path expects 48000 Hz, resample to avoid pitch/tempo mismatch.

### `generateSpeechStream(text, options?, handlers)`

Generate speech audio in streaming mode with `onChunk` callbacks. Handlers should be lightweight; forward audio to native playback quickly.

Best practices and caveats:
- Chunk sizes vary by model and internal buffer. Avoid heavy CPU work in `onChunk`.
- Accumulating all chunks in JS for very long sessions can exhaust memory — prefer saving on native or writing to a file incrementally.
- To stop generation early, call `cancelSpeechStream()`.

### `startTtsPcmPlayer(sampleRate, channels)` / `writeTtsPcmChunk(samples)` / `stopTtsPcmPlayer()`

Important:
- `writeTtsPcmChunk` expects float PCM samples in [-1.0, 1.0]. Values outside this range will clip.
- Balance write frequency and chunk size: very small writes increase bridge overhead; very large writes increase latency.

### Persistence (save/share)

Use `saveTtsAudioToFile` to write a WAV file to an absolute path. On Android, prefer `saveTtsAudioToContentUri` when writing to user-selected directories (SAF). After saving to SAF, you can call `copyTtsContentUriToCache` to obtain a local copy for playback or sharing.

Android SAF notes:
- `saveTtsAudioToContentUri` accepts a directory content URI and filename and returns a content URI for the saved file. Use the returned URI to share or present to the user.

iOS notes:
- On iOS the native implementation writes into the app container. Use share APIs to export if needed.

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
  saveTtsAudioToFile,
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
    await saveTtsAudioToFile(accumulated, sampleRate, '/data/user/0/.../tts_out.wav');
  },
  onError: ({ message }) => console.warn('TTS stream error', message),
});

// cancel if needed
// await cancelSpeechStream();
// unsub();
```

## Troubleshooting & tuning

- Latency/stuttering: tune native player buffer sizes and write frequency. On Android adjust AudioTrack buffer sizes; on iOS tune AVAudioEngine settings.
- Memory: avoid retaining large arrays in JS for long sessions. Prefer native-side streaming-to-file if you expect long outputs.
- Threading: increase `numThreads` for better throughput on multi-core devices, but test memory usage.
- Quantization: `preferInt8` usually improves speed and memory but can slightly affect voice quality.
- Noise/length scale: smaller `lengthScale` speeds up speech; `noiseScale` and `noiseScaleW` can trade naturalness vs. clarity (model-dependent).

## Mapping to Native API (`src/NativeSherpaOnnx.ts`)

For advanced users the TurboModule exposes native primitives used by the JS wrappers. Key methods:

- `initializeTts(modelDir, modelType, numThreads, debug, noiseScale, noiseScaleW, lengthScale)`
- `generateTts(text, sid, speed)` — full-buffer generation
- `generateTtsStream(text, sid, speed)` — streaming generation (emits chunk events)
- `cancelTtsStream()`
- `startTtsPcmPlayer(sampleRate, channels)` / `writeTtsPcmChunk(samples)` / `stopTtsPcmPlayer()`
- `getTtsSampleRate()` / `getTtsNumSpeakers()`
- `saveTtsAudioToFile(...)` / `saveTtsAudioToContentUri(...)` / `copyTtsContentUriToCache(...)`

Use the high-level JS helpers in `react-native-sherpa-onnx/tts` where possible — they encapsulate conversions and event wiring.

## Model Setup

See [TTS_MODEL_SETUP.md](./TTS_MODEL_SETUP.md) for model downloads and setup steps.
