# PCM Live Stream API

This guide describes the **PCM Live Stream API**: native microphone capture with resampling that delivers PCM audio at the requested sample rate (e.g. 16 kHz for STT). **iOS and Android** both capture at a supported hardware rate (16000, 44100, or 48000 Hz), resample to the requested rate, and emit Int16 mono PCM. It is typically used together with the [Streaming STT API](stt_streaming.md) for live transcription.

**Import:** `react-native-sherpa-onnx/audio`

## Table of contents

- [Overview](#overview)
- [Quick Start: Live transcription](#quick-start-live-transcription)
- [API reference](#api-reference)
- [Integration with Streaming STT](#integration-with-streaming-stt)
- [Permissions](#permissions)
- [Other audio utilities](#other-audio-utilities)

---

## Overview

- **`createPcmLiveStream(options?)`** creates a handle for a live PCM stream from the device microphone.
- **Native capture** (Android: `SherpaOnnxPcmCapture`, iOS: `AVAudioEngine` + `AVAudioConverter`) performs resampling so PCM is always delivered at the requested `sampleRate` (e.g. 16000 for STT).
- Via **events** (`onData`, `onError`) the app receives base64-encoded Int16 PCM chunks; the module decodes them into float arrays in `[-1, 1]` for further processing (e.g. into `stream.processAudioChunk()`).

---

## Quick Start: Live transcription

Minimal example: start the microphone, feed PCM into a streaming STT stream, and display partial/final results.

```typescript
import { createPcmLiveStream } from 'react-native-sherpa-onnx/audio';
import { createStreamingSTT, getOnlineTypeOrNull } from 'react-native-sherpa-onnx/stt';

const SAMPLE_RATE = 16000;

// 1) Create streaming STT engine and stream (only if model supports streaming)
const onlineType = getOnlineTypeOrNull('transducer'); // or e.g. from detectSttModel
if (!onlineType) throw new Error('Model does not support streaming');

const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
  modelType: onlineType,
});
const stream = await engine.createStream();

// 2) PCM live stream with same sampleRate as STT
const pcm = createPcmLiveStream({ sampleRate: SAMPLE_RATE });

pcm.onError((msg) => console.error('PCM error:', msg));

const unsubData = pcm.onData(async (samples, sampleRate) => {
  const { result } = await stream.processAudioChunk(samples, sampleRate);
  if (result.text) console.log('Partial:', result.text);
});

await pcm.start();
// ... recording in progress ...

// 3) Stop and cleanup
await pcm.stop();
unsubData();
await stream.release();
await engine.destroy();
```

---

## API reference

### `createPcmLiveStream(options?)`

```ts
function createPcmLiveStream(
  options?: PcmLiveStreamOptions
): PcmLiveStreamHandle;
```

Creates a **PCM live stream** from the device microphone. Native capture and resampling ensure PCM is delivered at the requested `sampleRate`. The app must request and obtain microphone permission before calling `start()`.

**Options (`PcmLiveStreamOptions`):**

| Option              | Type     | Description |
|----------------------|----------|-------------|
| `sampleRate`         | `number` | Target sample rate (e.g. 16000 for STT). Default: `16000`. |
| `channelCount`       | `number` | Number of channels. Default: `1`. |
| `bufferSizeFrames`   | `number` | Buffer size in frames; 0 = platform default. Default: `0`. |

**Returns:** `PcmLiveStreamHandle` (see below).

---

### `PcmLiveStreamHandle`

| Method / property | Signature | Description |
|-------------------|-----------|-------------|
| `start`           | `() => Promise<void>` | Starts native capture. Ensure permission is granted first. |
| `stop`            | `() => Promise<void>` | Stops capture. |
| `onData`          | `(callback: (samples: number[], sampleRate: number) => void) => () => void` | Registers a listener for PCM chunks. `samples`: float array in `[-1, 1]`; `sampleRate` matches the configured rate. Returns an unsubscribe function. |
| `onError`         | `(callback: (message: string) => void) => () => void` | Registers a listener for errors. Returns an unsubscribe function. |

- **`onData`**: The module receives base64-encoded Int16 PCM from the native side, decodes it to float `[-1, 1]`, and invokes the callback with `(samples, sampleRate)`.
- **`onError`**: On capture or resampling errors, `message` is passed to the callback.

---

### Types

```ts
export type PcmLiveStreamOptions = {
  sampleRate?: number;      // default 16000
  channelCount?: number;    // default 1
  bufferSizeFrames?: number; // default 0
};

export type PcmLiveStreamHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onData: (callback: (samples: number[], sampleRate: number) => void) => () => void;
  onError: (callback: (message: string) => void) => () => void;
};
```

Import from the audio module:

```ts
import {
  createPcmLiveStream,
  type PcmLiveStreamOptions,
  type PcmLiveStreamHandle,
} from 'react-native-sherpa-onnx/audio';
```

---

## Integration with Streaming STT

Typical flow for **live transcription**:

1. **Create a streaming STT engine** with a streaming-capable model (`createStreamingSTT`, see [stt_streaming.md](stt_streaming.md)).
2. **Create one stream** per session: `engine.createStream()`.
3. **Create a PCM live stream** with the same `sampleRate` as the STT model (usually 16000): `createPcmLiveStream({ sampleRate: 16000 })`.
4. In the PCM handle’s **`onData`**: pass each chunk to `stream.processAudioChunk(samples, sampleRate)`; use `result.text` for partial/final transcripts and optionally `isEndpoint` for end-of-utterance.
5. **On stop**: call `pcm.stop()`, unsubscribe from `onData`/`onError`, optionally call `stream.inputFinished()` and run a final decode loop, then `stream.release()` and `engine.destroy()`.

Processing chunks serially (e.g. with a promise chain or queue) avoids overlapping calls, as suggested in the [Quick Start](#quick-start-live-transcription) example. A full example with start/stop and cleanup is in the example app at `example/src/screens/stt/STTScreen.tsx` (live transcription).

---

## Permissions

- **Android:** `RECORD_AUDIO` in `AndroidManifest.xml` and request at runtime.
- **iOS:** Set `NSMicrophoneUsageDescription` in `Info.plist` and obtain user permission.

Without permission, `start()` may fail or `onError` may fire.

**iOS Simulator:** On simulator, this module uses the **Audio Queue API** so the default input device is used. You should get PCM data; if the simulator has no microphone selected or produces silence, choose a valid input in the host Mac’s sound settings or test on a **physical device** for real mic input.

---

## Other audio utilities

In the same module `react-native-sherpa-onnx/audio`:

- **`convertAudioToFormat(inputPath, outputPath, format, outputSampleRateHz?)`** – Converts an audio file to a supported format (e.g. MP3, FLAC, WAV). On Android this requires FFmpeg prebuilts.
- **`convertAudioToWav16k(inputPath, outputPath)`** – Converts to WAV 16 kHz mono 16-bit PCM (e.g. for offline STT).

For conversion and FFmpeg options see the README and [disable-ffmpeg.md](disable-ffmpeg.md).
