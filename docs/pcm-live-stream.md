# PCM Live Stream

Native microphone capture with resampling. Delivers PCM audio at the requested sample rate (e.g. 16 kHz for STT). Typically used with [Streaming STT](stt-streaming.md) for live transcription.

**Import path:** `react-native-sherpa-onnx/audio`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [createPcmLiveStream()](#createpcmlivestreamoptions)
  - [PcmLiveStreamHandle](#pcmlivestreamhandle)
  - [Types](#types)
- [Integration with Streaming STT](#integration-with-streaming-stt)
- [Other Audio Utilities](#other-audio-utilities)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| Microphone capture | ✅ | Android: `SherpaOnnxPcmCapture`, iOS: Audio Queue API |
| Native resampling | ✅ | Captures at hardware rate (16k/44.1k/48k), resamples to requested rate |
| Float PCM delivery | ✅ | Base64 Int16 → `Float32Array` in [-1, 1] with preallocated buffer |
| Event-based | ✅ | `onData` and `onError` callbacks |
| GC-friendly | ✅ | Preallocated Float32Array, index-filled to reduce GC pressure |

The audio module uses the [buffer](https://www.npmjs.com/package/buffer) package for base64 decoding (declared dependency — no extra install needed).

---

## Quick Start

Live transcription: microphone → PCM → streaming STT → text.

```typescript
import { createPcmLiveStream } from 'react-native-sherpa-onnx/audio';
import { createStreamingSTT, getOnlineTypeOrNull } from 'react-native-sherpa-onnx/stt';

const SAMPLE_RATE = 16000;

// 1) Create streaming STT
const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
  modelType: 'transducer',
});
const stream = await engine.createStream();

// 2) Create PCM live stream
const pcm = createPcmLiveStream({ sampleRate: SAMPLE_RATE });

pcm.onError((msg) => console.error('PCM error:', msg));

const unsubData = pcm.onData(async (samples, sampleRate) => {
  const { result } = await stream.processAudioChunk(samples, sampleRate);
  if (result.text) console.log('Partial:', result.text);
});

await pcm.start();
// ... recording ...

// 3) Stop and cleanup
await pcm.stop();
unsubData();
await stream.release();
await engine.destroy();
```

---

## API Reference

### `createPcmLiveStream(options?)`

```ts
function createPcmLiveStream(
  options?: PcmLiveStreamOptions
): PcmLiveStreamHandle;
```

Create a PCM live stream from the device microphone. The app must have microphone permission granted before calling `start()`.

**Options (`PcmLiveStreamOptions`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sampleRate` | `number` | `16000` | Target sample rate (e.g. 16000 for STT) |
| `channelCount` | `number` | `1` | Number of channels |
| `bufferSizeFrames` | `number` | `0` | Buffer size in frames; 0 = platform default |

---

### `PcmLiveStreamHandle`

| Method | Signature | Description |
| --- | --- | --- |
| `start` | `() => Promise<void>` | Start native capture. Ensure permission is granted first |
| `stop` | `() => Promise<void>` | Stop capture |
| `onData` | `(callback: (samples: Float32Array, sampleRate: number) => void) => () => void` | Register listener for PCM chunks. Returns unsubscribe function |
| `onError` | `(callback: (message: string) => void) => () => void` | Register error listener. Returns unsubscribe function |

- **`onData`:** Receives base64-encoded Int16 PCM from native side, decodes to float [-1, 1], invokes callback with `(samples, sampleRate)`
- **`onError`:** Called on capture or resampling errors

---

### Types

```ts
export type PcmLiveStreamOptions = {
  sampleRate?: number;
  channelCount?: number;
  bufferSizeFrames?: number;
};

export type PcmLiveStreamHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onData: (callback: (samples: Float32Array, sampleRate: number) => void) => () => void;
  onError: (callback: (message: string) => void) => () => void;
};
```

```ts
import {
  createPcmLiveStream,
  type PcmLiveStreamOptions,
  type PcmLiveStreamHandle,
} from 'react-native-sherpa-onnx/audio';
```

---

## Integration with Streaming STT

Typical flow for live transcription:

1. **Create streaming STT engine** with a streaming-capable model (see [stt-streaming.md](stt-streaming.md))
2. **Create one stream** per session: `engine.createStream()`
3. **Create PCM live stream** with `sampleRate` matching the STT model (usually 16000)
4. In `onData`: pass each chunk to `stream.processAudioChunk(samples, sampleRate)`; use `result.text` for transcripts and `isEndpoint` for end-of-utterance
5. **On stop:** call `pcm.stop()`, unsubscribe, optionally `stream.inputFinished()`, then `stream.release()` and `engine.destroy()`

Process chunks serially (promise chain or queue) to avoid overlapping calls.

---

## Other Audio Utilities

Available in the same `react-native-sherpa-onnx/audio` module:

| Function | Description |
| --- | --- |
| `convertAudioToFormat(inputPath, outputPath, format, sampleRateHz?)` | Convert audio file to MP3, FLAC, WAV, etc. Android requires FFmpeg prebuilts |
| `convertAudioToWav16k(inputPath, outputPath)` | Convert to WAV 16 kHz mono 16-bit PCM (ideal for offline STT) |

See [audio-conversion.md](audio-conversion.md) for details.

---

## Detailed Examples

### Full live transcription with cleanup

```typescript
import { createPcmLiveStream } from 'react-native-sherpa-onnx/audio';
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';

const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
  modelType: 'transducer',
  enableEndpoint: true,
});
const stream = await engine.createStream();
const pcm = createPcmLiveStream({ sampleRate: 16000 });

let transcript = '';

const unsubError = pcm.onError((msg) => console.error(msg));
const unsubData = pcm.onData(async (samples, sr) => {
  const { result, isEndpoint } = await stream.processAudioChunk(samples, sr);
  if (result.text) transcript = result.text;
  if (isEndpoint) {
    console.log('Final:', transcript);
    transcript = '';
    await stream.reset();
  }
});

await pcm.start();

// ... later, when user taps "Stop" ...
await pcm.stop();
unsubData();
unsubError();
await stream.release();
await engine.destroy();
```

### Check streaming support before starting

```typescript
import { detectSttModel, getOnlineTypeOrNull } from 'react-native-sherpa-onnx/stt';

const detection = await detectSttModel({ type: 'asset', path: 'models/my-model' });
const onlineType = getOnlineTypeOrNull(detection.modelType);

if (!onlineType) {
  console.warn('This model does not support streaming/live transcription');
  return;
}
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| `start()` fails silently | Ensure microphone permission is granted before calling `start()` |
| No data events | Check permission; on iOS Simulator, ensure host Mac has a mic input selected |
| Audio sounds distorted | Verify `sampleRate` matches what the STT model expects (usually 16000) |
| Chunks overlap or get reordered | Process chunks serially — await each `processAudioChunk` before the next |
| High latency | Use smaller `bufferSizeFrames` (but too small may increase CPU usage) |

**Permissions:**

| Platform | Requirement |
| --- | --- |
| Android | `RECORD_AUDIO` in `AndroidManifest.xml` + runtime permission |
| iOS | `NSMicrophoneUsageDescription` in `Info.plist` + user permission |

**iOS Simulator:** Uses Audio Queue API with the default input device. If the simulator produces silence, check the host Mac's sound settings or test on a physical device.

---

## See Also

- [Streaming STT](stt-streaming.md) — Real-time recognition (feed PCM from this API)
- [STT (Offline)](stt.md) — Full-file transcription
- [Audio Conversion](audio-conversion.md) — Convert audio formats
