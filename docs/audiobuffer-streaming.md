# Pipeline audio buffers — live / streaming (`audiobuffer`)

## Introduction

**Live** native audio buffers: rolling window, optional spool, mic and **append** producers, and hooks used by **streaming** STT, enhancement pipelines, and waveform UI.

**Import path:** `react-native-sherpa-onnx/audiobuffer`

For decode helpers (FFmpeg, WAV conversion), see `react-native-sherpa-onnx/audio` and [audio-conversion.md](audio-conversion.md). For immutable offline workflows, see [Pipeline audio buffers — offline](audiobuffer-offline.md).

Practical default policy: live buffers default to `16000` Hz, so VAD/STT/segmentation typically consume `16000` PCM unless you explicitly configure another rate.

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline buffer](audiobuffer-offline.md)** | One-shot, **immutable** clip: full PCM decoded on the native side (small clips in memory, large WAVs often **file-backed**). | Batch STT/TTS/alignment, preparing a file once, then feeding it into APIs via a **buffer ref/id** (prefer refs) instead of a huge float array in JS. |
| **[Live buffer](audiobuffer-streaming.md)** | **Rolling** window (ring) plus optional **spool** for long sessions; lifecycle **`recording` → `finished`**. Mic, file replay, and native pipeline workers all **append** on the native side. | Mic capture, streaming STT/enhancement, waveform UI, any stage that must grow over time while another native consumer **drains** the same buffer. |

**Offline and live work together:** both use **stable buffer ids** and the same TurboModule surface. Use **`appendOfflineToLiveAudioBuffer`** to play an offline clip into a live stream, **`ingestFileToLiveAudioBuffer`** to decode a file directly into a recording buffer, and **`createOfflineAudioBufferFromLive`** (on the [offline](audiobuffer-offline.md) page) to snapshot live audio for batch work. Native pipelines chain **live → live** so PCM **stays in native memory** between stages.

**Why this is fast:** orchestration uses **ids and small control calls**; steady-state streaming does not push PCM through the JS bridge. JS receives **events** (e.g. `pipelineLiveAudioChunk` / `onFramesAppended`) with metadata, independent of producer (`mic`, `append`, `append_offline`, `file_ingest`, or native pipeline **`source`**).

`pipelineLiveAudioChunk` means: **new frames were appended to the live buffer** — one contract for waveform UI, logging, and streaming STT without tying those concerns to a specific producer.

---

## Permissions

- **Android:** `RECORD_AUDIO`
- **iOS:** `NSMicrophoneUsageDescription`

---

## Ring window vs spool persistence

Live buffers are **window-first streaming buffers**:

- the active ring window is the primary read source for streaming consumers
- old frames are dropped from active reads once they leave the window
- no hidden full-history replay is implied by default behavior

### Default behavior (recommended baseline)

- `createEmptyLiveAudioBuffer(...)` does **not** auto-create a spool file
- reads and pipeline drains operate on the currently available ring window
- this keeps disk usage predictable for long-running sessions

### When to enable spool explicitly

Provide `persistencePath` when you need full-history retention beyond the active window, for example:

- creating an offline buffer from the full finalized session via `createOfflineAudioBufferFromLive('fullIfSpooled')`
- exporting long recordings where early segments may have left the ring
- post-processing workflows that must not lose pre-window audio

Without spool, APIs working on live reads/snapshots are window-bounded by design.

---

## Quick start

### Live mic + streaming STT (pipeline path)

```typescript
// Mic → live ring buffer → native streaming STT worker → live text buffer.
// Shows: append events (which producer wrote PCM) and a simple UI poll loop for partial + committed text.

import {
  createEmptyLiveAudioBuffer,
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
import {
  listAvailableInputDevices,
  listAvailableOutputDevices,
  setPipelineAudioRoutePreference,
} from 'react-native-sherpa-onnx/audio';

const SAMPLE_RATE = 16000;

// Online recognizer + text sink (same sample rate as `live` below).
const recognizer = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/my-streaming-model' },
  modelType: 'transducer',
});
const textOut = await createLiveTextBuffer({
  windowMaxChars: 65536,
  maxSegments: 2048,
});

// Live audio: mic and/or append paths all show up as `onFramesAppended` with a `source` tag.
const live = await createEmptyLiveAudioBuffer({
  sampleRate: SAMPLE_RATE,
  channelCount: 1,
  windowSeconds: 120,
  streamEvents: { framesAppended: { enabled: true, minIntervalMs: 0 } },
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

// Optional: set global input/output preference before starting mic.
// See: [Pipeline Audio Session Coordination](audio-session.md)
const inputDevices = await listAvailableInputDevices();
const outputDevices = await listAvailableOutputDevices();
const preferredInput = inputDevices.find((d) => d.kind === 'built_in_mic') ?? inputDevices[0];
const preferredOutput =
  outputDevices.find((d) => d.kind === 'built_in_speaker') ?? outputDevices[0];

await setPipelineAudioRoutePreference({
  ...(preferredInput ? { inputDeviceId: preferredInput.id } : {}),
  ...(preferredOutput ? { outputDeviceId: preferredOutput.id } : {}),
});

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

`onFramesAppended` receives producer metadata only: `source`, `frameCount`, `sampleRate`, `totalSamplesWritten`.

---

## Example: producer-agnostic callback with mixed sources

```typescript
// No microphone: push a tiny float chunk, then splice a whole offline WAV into the same live buffer.
// Same `onFramesAppended` callback sees different `source` values (`append` vs `append_offline`).

import {
  createEmptyLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const offline = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/tmp/voice.wav',
});

const live = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  streamEvents: { framesAppended: { enabled: true, minIntervalMs: 50 } },
  onFramesAppended: (e) => {
    console.log(`[${e.source}] +${e.frameCount} frames, total=${e.totalSamplesWritten}`);
    // Example output: [append] +3 frames, total=3
    // Example output: [append_offline] +48000 frames, total=48003
  },
});

appendSamplesToLiveAudioBuffer(live, new Float32Array([0.1, 0.2, 0.3]), 16000); // source=append
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

- `createEmptyLiveAudioBuffer`, `subscribeLiveAudioBufferEvents`
- `startMicToLiveAudioBuffer`, `stopMicToLiveAudioBuffer`
- `appendSamplesToLiveAudioBuffer`, `appendOfflineToLiveAudioBuffer`, `ingestFileToLiveAudioBuffer`, `finalizeLiveAudioBuffer`
- `getLiveAudioBufferSamplesSlice`
- `installJSI`, `isJSIAvailable`
- Callbacks: `onFramesAppended` / `onError` on `createEmptyLiveAudioBuffer`, or `subscribeLiveAudioBufferEvents`
- High-frequency native → JS for appends: optional `streamEvents.framesAppended` (`enabled` + `minIntervalMs`); if omitted, registering `onFramesAppended` opts in to events (see [`CreateEmptyLiveAudioBufferOptions`](../src/audiobuffer/types.ts))

Device routing belongs to `react-native-sherpa-onnx/audio`: use `listAvailableInputDevices()`, `listAvailableOutputDevices()`, and `setPipelineAudioRoutePreference(...)`.

Types: see [`src/audiobuffer/types.ts`](../src/audiobuffer/types.ts). **`createEmptyLiveAudioBuffer`** returns **`LiveAudioBufferRef`** (`info` + `LiveBufferHandleRecording` + `unsubscribeEvents`). Buffer parameters use **`LiveAudioBufferIdSource`**, **`LiveAudioBufferRecordingSource`**, or **`PipelineAudioBufferIdSource`**: pass the ref, last **`PipelineAudioBufferInfo`**, a branded handle, or a raw string id.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/audiobuffer`. Unless noted, buffer arguments accept the matching `*IdSource` union (ref, info snapshot, handle, or string). Device/route APIs are exported from `react-native-sherpa-onnx/audio`.

Ref-first usage is recommended: pass the buffer ref directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT`.

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

#### `createEmptyLiveAudioBuffer(options)`

```ts
function createEmptyLiveAudioBuffer(
  options: CreateEmptyLiveAudioBufferOptions
): Promise<LiveAudioBufferRef>;
```

If `options.sampleRate` is omitted, the live buffer defaults to `16000` Hz.

```ts
const live = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  streamEvents: { framesAppended: { enabled: true, minIntervalMs: 0 } },
  onFramesAppended: (e) => console.log(e.frameCount),
});
```

**Listener cleanup:** `createEmptyLiveAudioBuffer` returns a ref with an `unsubscribeEvents` function. Calling `live.unsubscribeEvents()` removes **only** the callbacks passed during this `createEmptyLiveAudioBuffer` call.

#### `ingestFileToLiveAudioBuffer(liveBuffer, source, options?)`

```ts
function ingestFileToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  source: FileSource,
  options?: FileIngestOptions
): Promise<FileIngestHandle>;
```

```ts
const ingest = await ingestFileToLiveAudioBuffer(
  live,
  { kind: 'fs', path: '/tmp/voice.opus' },
  {
    targetSampleRateHz: 16000,
    autoFinalize: true,
    onProgress: (event) => console.log(event.percent),
  }
);

await ingest.done;
```

Use this when the source audio is still a file and you want downstream native consumers to start processing before the whole file has been decoded.

`options.targetSampleRateHz` semantics:

- omit / `undefined` → `16000` Hz
- `0` → keep source file rate
- `> 0` → resample to that exact rate

- Source kind: any `FileSource`
- Buffer state: live buffer must still be `recording`
- Progress: `options.onProgress` receives `DecodeProgressEvent`
- Cancellation: `ingest.cancel()` or `options.signal`
- Append source: `onFramesAppended` receives `source: 'file_ingest'`
- Completion: `ingest.done` resolves with `FileIngestResult`

Robust stop ordering for active ingest:

```ts
ingest.cancel();
await ingest.done.catch(() => {
  // DECODE_CANCELLED is expected after cancel
});
await finalizeLiveAudioBuffer(live);
```

Call `finalizeLiveAudioBuffer` only after ingest reached a terminal state. This avoids
producer/finalize races and ensures decode work is stopped before finalization.


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

// later:
unsub();
```

Use this for the **advanced "two-level" event story** (shared with `textbuffer`):
1. **Default:** Pass callbacks to `createEmptyLiveAudioBuffer` and use `live.unsubscribeEvents()`.
2. **Advanced:** Attach additional listeners later (e.g. from a different UI component) using `subscribeLiveAudioBufferEvents`. The returned function unregisters **only** the listeners from that specific call.

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

Use `setPipelineAudioRoutePreference(...)` from `react-native-sherpa-onnx/audio` for global input/output preference.

#### `appendSamplesToLiveAudioBuffer(liveBuffer, samples, sampleRate)`

```ts
function appendSamplesToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  samples: Float32Array,
  sampleRate: number
): void;
```

```ts
appendSamplesToLiveAudioBuffer(live, new Float32Array([0.0, 0.1, 0.2]), 16000);
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
): Float32Array;
```

```ts
const chunk = getLiveAudioBufferSamplesSlice(live, 0, 320);
```

#### Convert finalized live buffer to file

After `finalizeLiveAudioBuffer`, use `react-native-sherpa-onnx/audio`:

```ts
import { saveAudioAsFile, saveAudioAsWav16k } from 'react-native-sherpa-onnx/audio';

await finalizeLiveAudioBuffer(live);
await saveAudioAsFile(live, { kind: 'fs', path: '/tmp/live.opus' }, 'opus', {
  outputSampleRateHz: 16000,
});
await saveAudioAsWav16k(live, { kind: 'fs', path: '/tmp/live_16k.wav' });
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

## Segmentation

Live audio buffers can attach segmentation behavior at creation time through `CreateEmptyLiveAudioBufferOptions.segmentation`.

- `off`: no segmentation attachment.
- `manual`: segment boundaries are controlled externally.
- `auto`: attach segmentation engine with a speech policy (default evaluator: `speech_energy_silence`).

This is useful when a long-running live session should expose deterministic chunk boundaries to downstream consumers while keeping PCM in native memory.

```ts
const live = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  channelCount: 1,
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'speech_energy_silence', minSegmentMs: 1000 },
  },
});
```

See [segmentation-engine.md](segmentation-engine.md) for the shared policy model and [memory-and-models.md](memory-and-models.md) for memory/OOM planning.

---

## Types and constants

```ts
import type {
  LiveAudioBufferRef, // live buffer ref with info + recording handle
  LiveAudioBufferInfo, // metadata for live ring/spool buffer
  LiveAudioBufferIdSource, // ref/handle/id accepted by live APIs
  LiveAudioBufferRecordingSource, // recording-only source accepted by append/finalize APIs
  CreateEmptyLiveAudioBufferOptions, // options for createEmptyLiveAudioBuffer
  LiveAudioBufferFramesAppendedEvent, // producer-agnostic append event payload
  LiveAudioBufferErrorEvent, // error event payload for live buffer
  FileIngestHandle, // controls active file ingest into live buffer
  FileIngestOptions, // options for ingestFileToLiveAudioBuffer
  PipelineAudioBufferInfo, // offline/live metadata union for info APIs
  PipelineAudioErrorCodeValue, // string union of audio error codes
} from 'react-native-sherpa-onnx/audiobuffer';

import {
  PipelineAudioErrorCode, // runtime constants for code-based error handling
  subscribeLiveAudioBufferEvents, // attach additional listeners beyond create-time callbacks
} from 'react-native-sherpa-onnx/audiobuffer';
```

## Error codes

| Code | Meaning |
| --- | --- |
| `AUDIO_BUFFER_NOT_FOUND` | Referenced pipeline audio buffer id does not exist |
| `AUDIO_BUFFER_KIND_MISMATCH` | Buffer kind does not match the called API (offline vs live) |
| `AUDIO_BUFFER_EMPTY` | Buffer has no samples for the requested operation |
| `AUDIO_INVALID_ARGUMENT` | Invalid buffer id/argument passed to API |
| `AUDIO_CAPTURE_ERROR` | Microphone capture failed to start or continue |
| `AUDIO_INVALID_STATE` | Live buffer is not in required state (`recording`/`finished`) |
| `AUDIO_ALREADY_FINALIZED` | Operation expects recording buffer but buffer is already finalized |
| `DECODE_NOT_FOUND` | Ingest source file not found or not accessible |
| `DECODE_OPEN_FAILED` | Ingest source could not be opened/probed |
| `DECODE_NO_AUDIO_STREAM` | Ingest source has no audio stream |
| `DECODE_CODEC_UNSUPPORTED` | Ingest source codec could not be initialized/decoded |
| `DECODE_DECODE_ERROR` | Ingest decode loop failed while reading frames |
| `DECODE_RESAMPLE_ERROR` | Ingest resample/downmix stage failed |
| `DECODE_CANCELLED` | Ingest/decode cancelled via signal or cancel call |
| `DECODE_PERMISSION_DENIED` | Platform denied permission to read source |
| `DECODE_INTERNAL_ERROR` | Generic native decode/ingest failure |

---

## Migration from removed `createPcmLiveStream`

The previous **`react-native-sherpa-onnx/audio`** helper **`createPcmLiveStream`** (events `pcmLiveStreamData` / `pcmLiveStreamError`) has been **removed**. Use **`audiobuffer`**: create a **live buffer** with `onFramesAppended` (and optional `streamEvents.framesAppended` for throttling), start mic capture (or append from other producers), and consume those callbacks.

---

## See also

- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Streaming STT](stt-streaming.md)
- [Offline STT / buffers](stt-offline.md)
- [PCM Player (`react-native-sherpa-onnx/pcm`)](pcm-player.md)

## Use case examples

<details>
<summary>Live ingest from file into streaming STT pipeline</summary>

```ts
const live = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const textOut = await createLiveTextBuffer({ maxSegments: 2048 });
const stt = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/streaming-stt' },
  modelType: 'auto',
});

const pipeline = await stt.transcribe(live, textOut, { chunkSize: 3200 });
const ingest = await ingestFileToLiveAudioBuffer(
  live,
  { kind: 'fs', path: '/tmp/session.wav' },
  { targetSampleRateHz: 16000, autoFinalize: true }
);

await ingest.done;
await pipeline.flush();
await pipeline.stop();
```

</details>

<details>
<summary>Append offline clip into live buffer for downstream consumers</summary>

```ts
const offline = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/tmp/clip.wav' });
const live = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
await appendOfflineToLiveAudioBuffer(live, offline);
await finalizeLiveAudioBuffer(live);
```

</details>
