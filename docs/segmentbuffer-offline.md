# Pipeline segment buffers — offline (`segmentbuffer`)

**Offline segment buffers** are immutable snapshots that can be consumed by batch pipelines and export flows.

**Import path:** `react-native-sherpa-onnx/segmentbuffer`

---

## Concepts

Offline segment buffers are typically created from a live segment buffer using:
- `windowSnapshot` for current in-memory window
- `fullIfSpooled` for strict spool-backed full history

---

## Quick start: read offline segments

```ts
import {
  createLiveSegmentBuffer,
  appendLiveSegment,
  createOfflineSegmentBufferFromLive,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

const live = await createLiveSegmentBuffer({ spooling: { mode: 'on' } });
await appendLiveSegment(live, {
  sourceAudioBufferId: 'live_abc',
  startSample: 3200,
  endSample: 9600,
  sampleRate: 16000,
});

const offline = await createOfflineSegmentBufferFromLive(live, 'fullIfSpooled');
const segments = await getOfflineSegmentBufferSegments(offline, 0, 128);
console.log(segments.map((s) => `${s.startSample}-${s.endSample}`));

await releasePipelineSegmentBuffer(offline);
await releasePipelineSegmentBuffer(live);
```

---

## API reference

- `createEmptyOfflineSegmentBuffer(options?)`
- `createOfflineSegmentBufferFromLive(liveBuffer, mode?)`
- `getOfflineSegmentBufferSegments(buffer, start?, maxCount?)`
- `getPipelineSegmentBufferInfo(buffer)`
- `releasePipelineSegmentBuffer(buffer)`

---

## Error code quick table

The following codes are the relevant runtime outcomes for offline segment-buffer reads and live-to-offline conversion in this document.

| Code | Meaning |
| --- | --- |
| `SEGMENT_BUFFER_NOT_FOUND` | Referenced segment buffer does not exist |
| `SEGMENT_BUFFER_KIND_MISMATCH` | Buffer kind does not match called API |
| `SEGMENT_INVALID_ARGUMENT` | Invalid argument or malformed id |
| `SEGMENT_INVALID_STATE` | Operation not allowed in current state |
| `SEGMENT_ALREADY_FINALIZED` | A recording-only operation was called on an already finished live buffer during conversion flows |
| `SEGMENT_SLICE_INVALID` | Invalid slice range |
| `SEGMENT_SPOOL_WRITE_FAILED` | Writing checkpoint/journal spool data failed in preceding live-buffer stages |
| `SEGMENT_SPOOL_UNAVAILABLE` | `fullIfSpooled` requested but spool unavailable |
| `SEGMENT_SPOOL_READ_FAILED` | Failed to read spool |
| `SEGMENT_SPOOL_CORRUPTED` | Corrupted spool content |
| `SEGMENT_INTERNAL_ERROR` | Generic native failure |
