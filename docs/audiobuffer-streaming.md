# Pipeline audio buffers — live / streaming (`audiobuffer`)

**Live** native audio buffers: rolling window, optional spool, mic and **append** producers, and hooks used by **streaming** STT, enhancement pipelines, and waveform UI.

**Import path:** `react-native-sherpa-onnx/audiobuffer`

For decode helpers (FFmpeg, WAV conversion), see `react-native-sherpa-onnx/audio` and [audio-conversion.md](audio-conversion.md). Overview of both buffer kinds: [Pipeline audio buffers — overview](audiobuffer.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline buffer](audiobuffer-offline.md)** | One-shot, **immutable** clip: full PCM decoded on the native side (small clips in memory, large WAVs often **file-backed**). | Batch STT/TTS/alignment, preparing a file once, then feeding it into APIs that expect a **buffer id** instead of a huge float array in JS. |
| **[Live buffer](audiobuffer-streaming.md)** | **Rolling** window (ring) plus optional **spool** for long sessions; lifecycle **`recording` → `finished`**. Mic, file replay, and native pipeline workers all **append** on the native side. | Mic capture, streaming STT/enhancement, waveform UI, any stage that must grow over time while another native consumer **drains** the same buffer. |

**Offline and live work together:** both use **stable buffer ids** and the same TurboModule surface. Use **`appendOfflineToLiveAudioBuffer`** to play an offline clip into a live stream, and **`createOfflineAudioBufferFromLive`** (on the [offline](audiobuffer-offline.md) page) to snapshot live audio for batch work. Native pipelines chain **live → live** so PCM **stays in native memory** between stages.

**Why this is fast:** orchestration uses **ids and small control calls**; steady-state streaming does not push PCM through the JS bridge. JS receives **events** (e.g. `pipelineLiveAudioChunk` / `onFramesAppended`) with metadata, independent of producer (`mic`, `append`, `append_offline`, or native pipeline **`source`**).

`pipelineLiveAudioChunk` means: **new frames were appended to the live buffer** — one contract for waveform UI, logging, and streaming STT without tying those concerns to a specific producer.

---

## Permissions

- **Android:** `RECORD_AUDIO`
- **iOS:** `NSMicrophoneUsageDescription`

---

## Quick start: live mic + streaming STT (pipeline path)

```typescript
// Mic → live ring buffer → native streaming STT worker → live text buffer.
// Shows: append events (which producer wrote PCM) and a simple UI poll loop for partial + committed text.

import {
  createLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import {
  createLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const SAMPLE_RATE = 16000;

// Online recognizer + text sink (same sample rate as `live` below).
const recognizer = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/my-streaming-model' },
  modelType: 'transducer',
});
const textOut = await createLiveTextBuffer({
  windowMaxChars: 65536,
  maxSegments: 2048,
});

// Live audio: mic and/or append paths all show up as `onFramesAppended` with a `source` tag.
const live = await createLiveAudioBuffer({
  sampleRate: SAMPLE_RATE,
  channelCount: 1,
  windowSeconds: 120,
  emitAppendedEvents: true,
  emitAppendedSamples: false,
  appendEventMinIntervalMs: 0,
  onFramesAppended: (e) => {
    // Producer-agnostic: mic, JS append, offline append, or native pipeline `source`.
    console.log(`[${e.source}] +${e.frameCount} frames`);
    // Example output: [mic] +320 frames
  },
  onError: (e) => {
    console.error('Live buffer error:', e.message, e.liveBufferId);
    // Example output: Live buffer error: BUFFER_WINDOW_OVERFLOW live_abc123
  },
});

// Starts native worker: drains `live`, writes partial + segments to `textOut`.
const pipeline = await recognizer.transcribe(live, textOut, {
  chunkSize: 3200,
});

// Poll text buffers from JS (STT itself stays native); tune interval vs battery.
const previewTimer = setInterval(async () => {
  const partial = await getLiveTextBufferPartialSlice(textOut, 0, 4096);
  const segmentCount = await getLiveTextBufferSegmentCount(textOut);
  const segments =
    segmentCount > 0
      ? await getLiveTextBufferSegments(textOut, 0, segmentCount)
      : [];
  const committed = segments.map((s) => s.text).join(' ');
  const text = [committed, partial].filter(Boolean).join(' ').trim();
  console.log(text);
  // Example output: hello wor
  // Example output (after endpoint): hello world
}, 150);

await startMicToLiveAudioBuffer(live);
// … recording …
await stopMicToLiveAudioBuffer();
clearInterval(previewTimer);

await pipeline.flush();

live.unsubscribeEvents();
await pipeline.stop();
await recognizer.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(live);
```

`onFramesAppended` receives producer metadata: `source`, `frameCount`, `sampleRate`, `totalSamplesWritten`, and optional `samples`.

---

## Example: producer-agnostic callback with mixed sources

```typescript
// No microphone: push a tiny float chunk, then splice a whole offline WAV into the same live buffer.
// Same `onFramesAppended` callback sees different `source` values (`append` vs `append_offline`).

import {
  createLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const offline = await createOfflineAudioBufferFromFile('/tmp/voice.wav');

const live = await createLiveAudioBuffer({
  sampleRate: 16000,
  emitAppendedEvents: true,
  emitAppendedSamples: false,
  appendEventMinIntervalMs: 50,
  onFramesAppended: (e) => {
    console.log(`[${e.source}] +${e.frameCount} frames, total=${e.totalSamplesWritten}`);
    // Example output: [append] +3 frames, total=3
    // Example output: [append_offline] +48000 frames, total=48003
  },
});

await appendSamplesToLiveAudioBuffer(live, [0.1, 0.2, 0.3], 16000); // source=append
await appendOfflineToLiveAudioBuffer(live, offline); // source=append_offline

live.unsubscribeEvents();
await releasePipelineAudioBuffer(offline);
await releasePipelineAudioBuffer(live);
```

---

## Main API (summary)

### General

- `getPipelineAudioBufferInfo`, `releasePipelineAudioBuffer`

### Live buffer

- `createLiveAudioBuffer`, `subscribeLiveAudioBufferEvents`
- `startMicToLiveAudioBuffer`, `stopMicToLiveAudioBuffer`
- `appendSamplesToLiveAudioBuffer`, `appendOfflineToLiveAudioBuffer`, `finalizeLiveAudioBuffer`
- `getLiveAudioBufferSamplesSlice`, `saveLiveAudioBufferToWav`
- Callbacks: `onFramesAppended` / `onError` on `createLiveAudioBuffer`, or `subscribeLiveAudioBufferEvents`

Types: see [`src/audiobuffer/types.ts`](../src/audiobuffer/types.ts). **`createLiveAudioBuffer`** returns **`LiveAudioBufferRef`** (`info` + `LiveBufferHandleRecording` + `unsubscribeEvents`). Buffer parameters use **`LiveAudioBufferIdSource`**, **`LiveAudioBufferRecordingSource`**, or **`PipelineAudioBufferIdSource`**: pass the ref, last **`PipelineAudioBufferInfo`**, a branded handle, or a raw string id.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/audiobuffer`. Unless noted, buffer arguments accept the matching `*IdSource` union (ref, info snapshot, handle, or string).

### General

#### `getPipelineAudioBufferInfo(buffer)`

```ts
function getPipelineAudioBufferInfo(
  buffer: PipelineAudioBufferIdSource
): Promise<PipelineAudioBufferInfo>;
```

```ts
const info = await getPipelineAudioBufferInfo(live);
console.log(info.kind, info.state);
```

#### `releasePipelineAudioBuffer(buffer)`

```ts
function releasePipelineAudioBuffer(buffer: PipelineAudioBufferIdSource): Promise<void>;
```

```ts
await releasePipelineAudioBuffer(live);
```

### Live buffer

#### `createLiveAudioBuffer(options)`

```ts
function createLiveAudioBuffer(
  options: CreateLiveAudioBufferOptions
): Promise<LiveAudioBufferRef>;
```

```ts
const live = await createLiveAudioBuffer({
  sampleRate: 16000,
  emitAppendedEvents: true,
  onFramesAppended: (e) => console.log(e.frameCount),
});
```

#### `subscribeLiveAudioBufferEvents(liveBuffer, callbacks)`

```ts
function subscribeLiveAudioBufferEvents(
  liveBuffer: LiveAudioBufferIdSource,
  callbacks: LiveAudioBufferCallbacks
): () => void;
```

```ts
const unsub = subscribeLiveAudioBufferEvents(live, {
  onFramesAppended: (e) => console.log(e.frameCount),
  onError: (e) => console.error(e.message, e.liveBufferId),
});
unsub();
```

#### `startMicToLiveAudioBuffer(liveBuffer, options?)` / `stopMicToLiveAudioBuffer()`

```ts
function startMicToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  options?: StartMicToLiveOptions
): Promise<void>;

function stopMicToLiveAudioBuffer(): Promise<void>;
```

```ts
await startMicToLiveAudioBuffer(live, { emitToJs: false });
await stopMicToLiveAudioBuffer();
```

#### `appendSamplesToLiveAudioBuffer(liveBuffer, samples, sampleRate)`

```ts
function appendSamplesToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  samples: number[],
  sampleRate: number
): Promise<void>;
```

```ts
await appendSamplesToLiveAudioBuffer(live, [0.0, 0.1, 0.2], 16000);
```

#### `finalizeLiveAudioBuffer(liveBuffer)`

```ts
function finalizeLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource
): Promise<LiveBufferHandleFinished>;
```

```ts
const finishedId = await finalizeLiveAudioBuffer(live);
```

#### `getLiveAudioBufferSamplesSlice(liveBuffer, startFrame, frameCount)`

```ts
function getLiveAudioBufferSamplesSlice(
  liveBuffer: LiveAudioBufferIdSource,
  startFrame: number,
  frameCount: number
): Promise<number[]>;
```

```ts
const chunk = await getLiveAudioBufferSamplesSlice(live, 0, 320);
```

#### `saveLiveAudioBufferToWav(liveBuffer, outputPath)`

```ts
function saveLiveAudioBufferToWav(
  liveBuffer: LiveAudioBufferIdSource,
  outputPath: string
): Promise<void>;
```

```ts
await saveLiveAudioBufferToWav(live, '/tmp/live.wav');
```

### Conversion: Online buffer <--> Offline buffer

#### `appendOfflineToLiveAudioBuffer(liveBuffer, offlineBuffer)`

```ts
function appendOfflineToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  offlineBuffer: OfflineAudioBufferIdSource
): Promise<void>;
```

```ts
await appendOfflineToLiveAudioBuffer(live, offline);
```

---

## Migration from removed `createPcmLiveStream`

The previous **`react-native-sherpa-onnx/audio`** helper **`createPcmLiveStream`** (events `pcmLiveStreamData` / `pcmLiveStreamError`) has been **removed**. Use **`audiobuffer`**: create a **live buffer** with `emitAppendedEvents: true`, start mic capture (or append from other producers), and consume `onFramesAppended` callbacks.

---

## See also

- [Pipeline audio buffers — overview](audiobuffer.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Streaming STT](stt-streaming.md)
- [Offline STT / buffers](stt-offline.md)
- [PCM Player & `pcm-stream` import](pcm-stream.md)
