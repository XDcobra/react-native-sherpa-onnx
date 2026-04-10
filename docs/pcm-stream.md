# Pipeline audio buffers (`pcm-stream`)

Unified **offline** and **live** native audio buffers for pipelines: producers append into a **live** buffer on the native side, and producer-agnostic callbacks/events notify JS when new frames arrive.

**Import path:** `react-native-sherpa-onnx/pcm-stream`

For file decode helpers (FFmpeg, WAV conversion) and other utilities, see `react-native-sherpa-onnx/audio` and [audio-conversion.md](audio-conversion.md).

---

## Concepts

| Kind | Meaning |
| --- | --- |
| **Offline buffer** | Immutable, full PCM (in-memory for small inputs, file-backed for large WAV files). |
| **Live buffer** | Rolling ring window + optional linear **spool file**; state `recording` → `finished`. |

`pipelineLiveAudioChunk` now means: **new frames were appended to the live buffer**, independent of producer (`mic`, `append`, `append_offline`, future native sources).

The hook is centralized in the native live append path. This gives one contract for waveform UI, logging, and JS-side streaming STT.

---

## Permissions

- **Android:** `RECORD_AUDIO`
- **iOS:** `NSMicrophoneUsageDescription`

---

## Quick start: live mic + streaming STT (callback path)

```typescript
import {
  createLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/pcm-stream';
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';

const SAMPLE_RATE = 16000;

const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/my-streaming-model' },
  modelType: 'transducer',
});
const stream = await engine.createStream();

const { bufferId, unsubscribeEvents } = await createLiveAudioBuffer({
  sampleRate: SAMPLE_RATE,
  channelCount: 1,
  windowSeconds: 120,
  emitAppendedEvents: true,
  emitAppendedSamples: true,
  appendEventMinIntervalMs: 0,
  onFramesAppended: async (e) => {
    if (!e.samples?.length) return;
    const { result } = await stream.processAudioChunk(e.samples, e.sampleRate ?? SAMPLE_RATE);
    console.log(result.text);
  },
  onError: (e) => {
    console.error('Live buffer error:', e.message, e.liveBufferId);
  },
});

await startMicToLiveAudioBuffer(bufferId);
// … recording …
await stopMicToLiveAudioBuffer();
unsubscribeEvents();
await stream.release();
await engine.destroy();
await releasePipelineAudioBuffer(bufferId);
```

`onFramesAppended` receives producer metadata: `source`, `frameCount`, `sampleRate`, `totalSamplesWritten`, and optional `samples`.

---

## Example: producer-agnostic callback with mixed sources

```typescript
import {
  createLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/pcm-stream';

const { info: offInfo } = await createOfflineAudioBufferFromFile('/tmp/voice.wav');

const { bufferId, unsubscribeEvents } = await createLiveAudioBuffer({
  sampleRate: 16000,
  emitAppendedEvents: true,
  emitAppendedSamples: false,
  appendEventMinIntervalMs: 50,
  onFramesAppended: (e) => {
    console.log(`[${e.source}] +${e.frameCount} frames, total=${e.totalSamplesWritten}`);
  },
});

await appendSamplesToLiveAudioBuffer(bufferId, [0.1, 0.2, 0.3], 16000); // source=append
await appendOfflineToLiveAudioBuffer(bufferId, offInfo.bufferId); // source=append_offline

unsubscribeEvents();
await releasePipelineAudioBuffer(offInfo.bufferId);
await releasePipelineAudioBuffer(bufferId);
```

---

## Main API (summary)

Exported from `react-native-sherpa-onnx/pcm-stream`:

- **Offline:** `createOfflineAudioBufferFromFile`, `createOfflineAudioBufferFromSamples`, `createOfflineAudioBufferFromLive`, `saveOfflineAudioBufferToWav`, `getPipelineAudioBufferInfo`, `releasePipelineAudioBuffer`
- **Live:** `createLiveAudioBuffer`, `appendSamplesToLiveAudioBuffer`, `appendOfflineToLiveAudioBuffer`, `finalizeLiveAudioBuffer`, `saveLiveAudioBufferToWav`, `getLiveAudioBufferSamplesSlice`
- **Mic:** `startMicToLiveAudioBuffer(liveBufferId, { emitToJs? })`, `stopMicToLiveAudioBuffer`
- **Callbacks:** `onFramesAppended` / `onError` in `createLiveAudioBuffer(...)`, or `subscribeLiveAudioBufferEvents(...)`

Types: see [`src/pcm-stream/types.ts`](../src/pcm-stream/types.ts).

---

## Migration from removed `createPcmLiveStream`

The previous **`react-native-sherpa-onnx/audio`** helper **`createPcmLiveStream`** (events `pcmLiveStreamData` / `pcmLiveStreamError`) has been **removed**. Use **`pcm-stream`**: create a **live buffer** with `emitAppendedEvents: true`, start mic capture (or append from other producers), and consume `onFramesAppended` callbacks.

---

## See also

- [Streaming STT](stt-streaming.md)
- [Offline STT / buffers](stt-offline.md)
- [PCM Player](pcm-player.md)
