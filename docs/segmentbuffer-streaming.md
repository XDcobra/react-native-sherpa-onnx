# Pipeline segment buffers — live / streaming (`segmentbuffer`)

**Live segment buffers** store incremental segment events for long-running pipelines such as VAD and future streaming alignment flows.

**Import path:** `react-native-sherpa-onnx/segmentbuffer`

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **Live segment buffer** | Mutable segment stream (`recording` -> `finished`) with bounded in-memory log and optional spool-backed full history. | VAD live segmentation, real-time subtitle boundaries, incremental post-processing. |
| **Offline segment buffer** | Immutable snapshot of segments. | Batch consumers, export, deterministic replay. |

`fullIfSpooled` is strict: if spool is unavailable, conversion rejects with `SEGMENT_SPOOL_*`.

**Live events (opt-in):** `createLiveSegmentBuffer` supports `onSegmentAppended` / `onError` and optional throttling via `streamEvents.segmentAppended` (same `enabled` + `minIntervalMs` pattern as live audio and text buffers). Pipelines such as VAD use this for fat segment metadata without polling; see [vad-streaming.md](vad-streaming.md).

---

## Quick start: append + snapshot

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

const live = await createLiveSegmentBuffer({
  sourceAudioBufferId: 'live_123',
  maxSegments: 2048,
  spooling: { mode: 'on' },
});

await appendLiveSegment(live, {
  sourceAudioBufferId: 'live_123',
  startSample: 0,
  endSample: 16000,
  sampleRate: 16000,
  confidence: 0.93,
});

const count = await getLiveSegmentBufferSegmentCount(live);
const latest = await getLiveSegmentBufferSegments(live, 0, count);
console.log(latest.length);

await finalizeLiveSegmentBuffer(live);
const offline = await createOfflineSegmentBufferFromLive(live, 'fullIfSpooled');

await releasePipelineSegmentBuffer(offline);
await releasePipelineSegmentBuffer(live);
```

---

## API reference

### Create and lifecycle

- `createLiveSegmentBuffer(options?)`
- `createEmptyOfflineSegmentBuffer(options?)`
- `finalizeLiveSegmentBuffer(liveBuffer)`
- `releasePipelineSegmentBuffer(buffer)`

### Write and read

- `appendLiveSegment(liveBuffer, segment)`
- `getLiveSegmentBufferSegmentCount(liveBuffer)`
- `getLiveSegmentBufferSegments(liveBuffer, startIndex, maxCount)`
- `getOfflineSegmentBufferSegments(offlineBuffer, start?, maxCount?)`

### Conversion

- `createOfflineSegmentBufferFromLive(liveBuffer, mode?)`
  - `windowSnapshot`
  - `fullIfSpooled` (strict)

---

## Error code quick table

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
