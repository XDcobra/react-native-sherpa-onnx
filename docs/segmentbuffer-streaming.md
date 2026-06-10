# Pipeline segment buffers — live / streaming (`segmentbuffer`)

## Introduction

**Live segment buffers** store incremental segment events for long-running pipelines such as VAD and future streaming alignment flows.

**Import path:** `react-native-sherpa-onnx/segmentbuffer`

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline segment buffer](segmentbuffer-offline.md)** | Immutable snapshot of segments (`state: immutable`). | Batch consumers, export, deterministic replay. |
| **[Live segment buffer](segmentbuffer-streaming.md)** | Mutable segment stream (`recording` -> `finished`) with bounded in-memory log and optional spool-backed full history. | VAD live segmentation, runtime subtitle boundaries, incremental post-processing. |

`fullIfSpooled` is strict: if spool is unavailable, conversion rejects with `SEGMENT_SPOOL_*`.

**Live events (opt-in):** `createLiveSegmentBuffer` supports `onSegmentAppended` / `onError` and optional throttling via `streamEvents.segmentAppended` (`enabled` + `minIntervalMs`).

`sourceAudioBufferId` accepts `PipelineAudioBufferIdSource` (audio ref/info/handle/id), not only raw strings.

## Relation to streaming pipelines

Live segment buffers collect **time-range events** (VAD, future streaming alignment) produced by native workers. Workers are **started and drained** via feature **pipeline handles**; this page documents **buffer** create/finalize/snapshot only. See **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**.

---

## Main API (summary)

### Create and lifecycle

- `createLiveSegmentBuffer`
- `finalizeLiveSegmentBuffer`
- `createOfflineSegmentBufferFromLive`
- `releasePipelineSegmentBuffer`

### Write and read

- `appendLiveSegment`
- `getLiveSegmentBufferSegmentCount`
- `getLiveSegmentBufferSegments`
- `getPipelineSegmentBufferInfo`

---

## Segment payload contracts

`SegmentMeta.kind` defines the payload contract:

- `kind: 'speech'` -> strict `SpeechSegmentPayload` subtype by `payload.source`:
  - `source: 'vad'` -> allowed keys: `source`, `engine`, `decision`, `score`
  - `source: 'stt'` -> allowed keys: `source`, `transcript`, `tokenCount`, `isFinal`
  - `source: 'tts'` -> allowed keys: `source`, `text`, `chunkIndex`, `isFinalChunk`
- `kind: 'alignment'` -> `AlignmentSegmentPayload` (strict contract):
  - required: `text`, `timingMode`, `granularity`
  - optional: `confidence`, `tokenMetadata`, `wordMetadata`, `languageHints`

Runtime validation behavior:

- `speech` payload is validated strictly by `source` discriminator and source-specific key allowlist.
- `alignment` payload is validated strictly (required fields + allowed keys + value checks).
- invalid payloads fail with `SEGMENT_INVALID_ARGUMENT`.

---

## Quick start

### Append + snapshot

```ts
import {
  createLiveSegmentBuffer,
  appendLiveSegment,
  finalizeLiveSegmentBuffer,
  createOfflineSegmentBufferFromLive,
  getLiveSegmentBufferSegmentCount,
  getLiveSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';
import { createEmptyLiveAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

const liveAudio = await createEmptyLiveAudioBuffer({ sampleRate: 16000 });
const live = await createLiveSegmentBuffer({
  sourceAudioBufferId: liveAudio, // or: 'live_<uuid>'
  maxSegments: 2048,
  spooling: { mode: 'on' },
  streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
  onSegmentAppended: (e) => {
    console.log(`#${e.segmentIndex}`, e.startSample, e.endSample);
  },
});

await appendLiveSegment(live, {
  sourceAudioBufferId: liveAudio,
  startSample: 0,
  endSample: 16000,
  sampleRate: 16000,
  kind: 'speech',
  confidence: 0.93,
  payload: {
    source: 'vad',
    engine: 'vad',
    decision: 'model',
    score: 0.93,
  },
});

await appendLiveSegment(live, {
  sourceAudioBufferId: liveAudio,
  startSample: 16000,
  endSample: 32000,
  sampleRate: 16000,
  kind: 'alignment',
  payload: {
    text: 'Hello world',
    timingMode: 'vad',
    granularity: 'word',
    confidence: 0.97,
    languageHints: ['en'],
  },
});

const count = await getLiveSegmentBufferSegmentCount(live);
const latest = await getLiveSegmentBufferSegments(live, 0, count);
for (const seg of latest) {
  if (seg.kind === 'alignment') {
    console.log(seg.payload?.text, seg.payload?.timingMode);
  } else {
    console.log(seg.payload);
  }
}

await finalizeLiveSegmentBuffer(live);
const offline = await createOfflineSegmentBufferFromLive(live, 'fullIfSpooled');

await releasePipelineSegmentBuffer(offline);
await releasePipelineSegmentBuffer(live);
```

---

## API reference

### Create and lifecycle

#### `createLiveSegmentBuffer(options?)`

```ts
function createLiveSegmentBuffer(
  options?: CreateLiveSegmentBufferOptions
): Promise<LiveSegmentBufferRef>;
```

```ts
const live = await createLiveSegmentBuffer({
  sourceAudioBufferId: liveAudioRef, // or: 'live_<uuid>'
  streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
  onSegmentAppended: (e) => console.log(e.segmentIndex),
});
```

#### `finalizeLiveSegmentBuffer(liveBuffer)`

```ts
function finalizeLiveSegmentBuffer(
  buffer: LiveSegmentBufferRecordingSource
): Promise<void>;
```

```ts
await finalizeLiveSegmentBuffer(live);
```

#### `createOfflineSegmentBufferFromLive(liveBuffer, mode?)`

```ts
function createOfflineSegmentBufferFromLive(
  liveBuffer: LiveSegmentBufferIdSource,
  mode?: OfflineSegmentBufferFromLiveMode
): Promise<OfflineSegmentBufferRef>;
```

```ts
const offline = await createOfflineSegmentBufferFromLive(live, 'windowSnapshot');
```

#### `releasePipelineSegmentBuffer(buffer)`

```ts
function releasePipelineSegmentBuffer(
  buffer: PipelineSegmentBufferIdSource
): Promise<void>;
```

```ts
await releasePipelineSegmentBuffer(live);
```

### Write and read

#### `appendLiveSegment(liveBuffer, segment)`

```ts
function appendLiveSegment(
  buffer: LiveSegmentBufferRecordingSource,
  segment: SegmentInput
): Promise<{ segmentId: string; segmentIndex: number }>;
```

```ts
await appendLiveSegment(live, {
  sourceAudioBufferId: liveAudioRef,
  startSample: 3200,
  endSample: 9600,
  sampleRate: 16000,
});
```

#### `getLiveSegmentBufferSegmentCount(liveBuffer)`

```ts
function getLiveSegmentBufferSegmentCount(
  liveBuffer: LiveSegmentBufferIdSource
): Promise<number>;
```

```ts
const count = await getLiveSegmentBufferSegmentCount(live);
```

#### `getLiveSegmentBufferSegments(liveBuffer, startIndex, maxCount)`

```ts
function getLiveSegmentBufferSegments(
  liveBuffer: LiveSegmentBufferIdSource,
  startIndex: number,
  maxCount: number
): Promise<SegmentMeta[]>;
```

```ts
const items = await getLiveSegmentBufferSegments(live, 0, 32);
```

#### `getPipelineSegmentBufferInfo(buffer)`

```ts
function getPipelineSegmentBufferInfo(
  buffer: PipelineSegmentBufferIdSource
): Promise<PipelineSegmentBufferInfo>;
```

```ts
const info = await getPipelineSegmentBufferInfo(live);
console.log(info.kind, info.state);
```

---

## Types and constants

```ts
import type {
  LiveSegmentBufferRef, // live segment buffer ref with info + recording handle
  LiveSegmentBufferInfo, // live segment buffer metadata (state, spool, counts)
  LiveSegmentBufferIdSource, // ref/handle/id accepted by live APIs
  LiveSegmentBufferRecordingSource, // recording-only source for append/finalize APIs
  SegmentInput, // input payload type for appendLiveSegment
  SegmentMeta, // returned segment metadata union
  SpeechSegmentPayload, // strict speech payload by source discriminator
  AlignmentSegmentPayload, // strict alignment payload contract
  PipelineSegmentBufferInfo, // offline/live info union
  PipelineSegmentErrorCodeValue, // string union of segmentbuffer error codes
} from 'react-native-sherpa-onnx/segmentbuffer';

import {
  PipelineSegmentErrorCode, // runtime constants for code-based error handling
} from 'react-native-sherpa-onnx/segmentbuffer';
```

## Error codes

The following codes are the relevant runtime outcomes for live/streaming segment-buffer operations in this document (`create`, `append`, `finalize`, `slice`, `createOfflineFromLive`, `release`).

| Code | Meaning |
| --- | --- |
| `SEGMENT_BUFFER_NOT_FOUND` | Referenced segment buffer does not exist |
| `SEGMENT_BUFFER_KIND_MISMATCH` | Buffer kind does not match called API |
| `SEGMENT_INVALID_ARGUMENT` | Invalid argument or malformed buffer id |
| `SEGMENT_INVALID_STATE` | Operation not allowed in current state |
| `SEGMENT_ALREADY_FINALIZED` | Live buffer already finalized |
| `SEGMENT_SLICE_INVALID` | Invalid segment slice range |
| `SEGMENT_SPOOL_UNAVAILABLE` | `fullIfSpooled` requested but spool unavailable |
| `SEGMENT_SPOOL_WRITE_FAILED` | Spool write failed |
| `SEGMENT_SPOOL_READ_FAILED` | Spool read failed |
| `SEGMENT_SPOOL_CORRUPTED` | Spool data is corrupted |
| `SEGMENT_INTERNAL_ERROR` | Generic native segment buffer failure |

## See also

- [Pipeline segment buffers — offline](segmentbuffer-offline.md)
- [Voice Activity Detection (streaming)](vad-streaming.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md)

## Use case examples

<details>
<summary>Stream VAD segments and mirror to UI in real time</summary>

```ts
const liveSegments = await createLiveSegmentBuffer({
  sourceAudioBufferId: liveAudio,
  streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
  onSegmentAppended: (e) => {
    console.log(e.segmentIndex, e.kind, `${e.durationMs}ms`);
  },
});
```

</details>

<details>
<summary>Convert live segment stream to offline snapshot for batch processing</summary>

```ts
await finalizeLiveSegmentBuffer(liveSegments);
const offline = await createOfflineSegmentBufferFromLive(liveSegments, 'fullIfSpooled');
const items = await getOfflineSegmentBufferSegments(offline, 0, 128);
console.log(items.length);
await releasePipelineSegmentBuffer(offline);
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

