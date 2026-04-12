# Pipeline audio buffers (`audiobuffer`)

Unified **offline** and **live** native audio buffers for pipelines: producers append into a **live** buffer on the native side, and producer-agnostic callbacks/events notify JS when new frames arrive.

**Import path:** `react-native-sherpa-onnx/audiobuffer`

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

## Quick start: live mic + streaming STT (pipeline path)

```typescript
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

const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/my-streaming-model' },
  modelType: 'transducer',
});
const textOut = await createLiveTextBuffer({
  windowMaxChars: 65536,
  maxSegments: 2048,
});

const live = await createLiveAudioBuffer({
  sampleRate: SAMPLE_RATE,
  channelCount: 1,
  windowSeconds: 120,
  emitAppendedEvents: true,
  emitAppendedSamples: false,
  appendEventMinIntervalMs: 0,
  onFramesAppended: (e) => {
    // Producer-agnostic audio append callback (mic, append, append_offline, ...)
    console.log(`[${e.source}] +${e.frameCount} frames`);
  },
  onError: (e) => {
    console.error('Live buffer error:', e.message, e.liveBufferId);
  },
});

const pipeline = await engine.transcribe(live, textOut, {
  chunkSize: 3200,
});

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
}, 150);

await startMicToLiveAudioBuffer(live);
// … recording …
await stopMicToLiveAudioBuffer();
clearInterval(previewTimer);

await pipeline.flush();

live.unsubscribeEvents();
await pipeline.stop();
await engine.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(live);
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
} from 'react-native-sherpa-onnx/audiobuffer';

const offline = await createOfflineAudioBufferFromFile('/tmp/voice.wav');

const live = await createLiveAudioBuffer({
  sampleRate: 16000,
  emitAppendedEvents: true,
  emitAppendedSamples: false,
  appendEventMinIntervalMs: 50,
  onFramesAppended: (e) => {
    console.log(`[${e.source}] +${e.frameCount} frames, total=${e.totalSamplesWritten}`);
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

Exported from `react-native-sherpa-onnx/audiobuffer`:

### General

- `getPipelineAudioBufferInfo`, `releasePipelineAudioBuffer`

### Offline buffer

- `createOfflineAudioBufferFromFile`, `createOfflineAudioBufferFromSamples`, `createOfflineAudioBufferFromLive`, `saveOfflineAudioBufferToWav`

### Live buffer

- `createLiveAudioBuffer`, `subscribeLiveAudioBufferEvents`
- `startMicToLiveAudioBuffer`, `stopMicToLiveAudioBuffer`
- `appendSamplesToLiveAudioBuffer`, `appendOfflineToLiveAudioBuffer`, `finalizeLiveAudioBuffer`
- `getLiveAudioBufferSamplesSlice`, `saveLiveAudioBufferToWav`
- Callbacks: `onFramesAppended` / `onError` on `createLiveAudioBuffer`, or `subscribeLiveAudioBufferEvents`

Types: see [`src/audiobuffer/types.ts`](../src/audiobuffer/types.ts). Offline create helpers return **`OfflineAudioBufferRef`** (`info` + `OfflineBufferHandle`); **`createLiveAudioBuffer`** returns **`LiveAudioBufferRef`** (`info` + `LiveBufferHandleRecording` + `unsubscribeEvents`). Buffer parameters use **`OfflineAudioBufferIdSource`**, **`LiveAudioBufferIdSource`**, **`LiveAudioBufferRecordingSource`**, or **`PipelineAudioBufferIdSource`**: pass the ref, last **`PipelineAudioBufferInfo`**, a branded handle, or a raw string id.

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
const info = await getPipelineAudioBufferInfo(offline);
console.log(info.kind, info.state);
```

#### `releasePipelineAudioBuffer(buffer)`

```ts
function releasePipelineAudioBuffer(buffer: PipelineAudioBufferIdSource): Promise<void>;
```

```ts
await releasePipelineAudioBuffer(offline);
await releasePipelineAudioBuffer(live);
```

### Offline buffer

#### `createOfflineAudioBufferFromFile(sourcePath, targetSampleRateHz?, forceMono?)`

```ts
function createOfflineAudioBufferFromFile(
  sourcePath: string,
  targetSampleRateHz?: number,
  forceMono?: boolean
): Promise<OfflineAudioBufferRef>;
```

```ts
const offline = await createOfflineAudioBufferFromFile('/tmp/input.wav', 16000, true);
console.log(offline.info.sampleRate, offline.info.bufferId);
```

#### `createOfflineAudioBufferFromSamples(samples, sampleRate, channelCount?)`

```ts
function createOfflineAudioBufferFromSamples(
  samples: number[],
  sampleRate: number,
  channelCount?: number
): Promise<OfflineAudioBufferRef>;
```

```ts
const offline = await createOfflineAudioBufferFromSamples([0.1, 0.2, 0.3], 16000, 1);
```

#### `createOfflineAudioBufferFromLive(liveBuffer, mode?)`

```ts
function createOfflineAudioBufferFromLive(
  liveBuffer: LiveAudioBufferIdSource,
  mode?: OfflineFromLiveMode
): Promise<OfflineAudioBufferRef>;
```

```ts
const offlineFromLive = await createOfflineAudioBufferFromLive(live, 'fullIfSpooled');
```

#### `saveOfflineAudioBufferToWav(buffer, outputPath)`

```ts
function saveOfflineAudioBufferToWav(
  buffer: OfflineAudioBufferIdSource,
  outputPath: string
): Promise<void>;
```

```ts
await saveOfflineAudioBufferToWav(offline, '/tmp/offline.wav');
```

### Live buffer

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
});
unsub();
```

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

---

## Migration from removed `createPcmLiveStream`

The previous **`react-native-sherpa-onnx/audio`** helper **`createPcmLiveStream`** (events `pcmLiveStreamData` / `pcmLiveStreamError`) has been **removed**. Use **`audiobuffer`**: create a **live buffer** with `emitAppendedEvents: true`, start mic capture (or append from other producers), and consume `onFramesAppended` callbacks.

---

## See also

- [Streaming STT](stt-streaming.md)
- [Offline STT / buffers](stt-offline.md)
- [PCM Player & `pcm-stream` import](pcm-stream.md)
