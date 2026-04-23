# Pipeline segment buffers — offline (`segmentbuffer`)

**Offline segment buffers** are immutable segment snapshots used by batch consumers, export, and deterministic replay.

**Import path:** `react-native-sherpa-onnx/segmentbuffer`

For live append/event flows, see [segmentbuffer-streaming.md](segmentbuffer-streaming.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline segment buffer](segmentbuffer-offline.md)** | Immutable segment list (`state: immutable`). | Batch readers, export, deterministic post-processing. |
| **[Live segment buffer](segmentbuffer-streaming.md)** | Incremental segment stream (`recording -> finished`) with optional spool. | Streaming VAD / alignment and runtime UI updates. |

Offline buffers can be created:
- empty via `createEmptyOfflineSegmentBuffer(...)`
- from live via `createOfflineSegmentBufferFromLive(...)`

Conversion mode:
- `windowSnapshot`: current in-memory live window
- `fullIfSpooled`: strict full-history conversion; requires available spool

---

## Main API (summary)

### General

- `getPipelineSegmentBufferInfo`
- `releasePipelineSegmentBuffer`

### Offline buffer

- `createEmptyOfflineSegmentBuffer`
- `createOfflineSegmentBufferFromLive`
- `getOfflineSegmentBufferSegments`

Types: see [`src/segmentbuffer/types.ts`](../src/segmentbuffer/types.ts). Buffer arguments use matching `*IdSource` unions (ref, branded handle, or raw id string). `sourceAudioBufferId` supports `PipelineAudioBufferIdSource` (for example audio buffer ref or id).

---

## API reference

### General

#### `getPipelineSegmentBufferInfo(buffer)`

```ts
function getPipelineSegmentBufferInfo(
  buffer: PipelineSegmentBufferIdSource
): Promise<PipelineSegmentBufferInfo>;
```

```ts
const info = await getPipelineSegmentBufferInfo(offline);
console.log(info.kind, info.state);
```

#### `releasePipelineSegmentBuffer(buffer)`

```ts
function releasePipelineSegmentBuffer(
  buffer: PipelineSegmentBufferIdSource
): Promise<void>;
```

```ts
await releasePipelineSegmentBuffer(offline);
```

### Offline buffer

#### `createEmptyOfflineSegmentBuffer(options?)`

```ts
function createEmptyOfflineSegmentBuffer(
  options?: CreateEmptyOfflineSegmentBufferOptions
): Promise<OfflineSegmentBufferRef>;
```

```ts
const offline = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: liveAudioRef, // or: 'live_<uuid>'
});
```

#### `createOfflineSegmentBufferFromLive(liveBuffer, mode?)`

```ts
function createOfflineSegmentBufferFromLive(
  liveBuffer: LiveSegmentBufferIdSource,
  mode?: OfflineSegmentBufferFromLiveMode
): Promise<OfflineSegmentBufferRef>;
```

```ts
const offline = await createOfflineSegmentBufferFromLive(liveSegments, 'fullIfSpooled');
```

#### `getOfflineSegmentBufferSegments(buffer, start?, maxCount?)`

```ts
function getOfflineSegmentBufferSegments(
  buffer: OfflineSegmentBufferIdSource,
  start?: number,
  maxCount?: number
): Promise<SegmentMeta[]>;
```

```ts
const segments = await getOfflineSegmentBufferSegments(offline, 0, 64);
console.log(segments.map((s) => s.durationMs));
```

---

## Error code quick table

The following codes are the relevant runtime outcomes for offline reads and live-to-offline conversion in this page.

| Code | Meaning |
| --- | --- |
| `SEGMENT_BUFFER_NOT_FOUND` | Referenced segment buffer does not exist |
| `SEGMENT_BUFFER_KIND_MISMATCH` | Buffer kind does not match called API |
| `SEGMENT_INVALID_ARGUMENT` | Invalid argument or malformed id |
| `SEGMENT_INVALID_STATE` | Operation not allowed in current state |
| `SEGMENT_ALREADY_FINALIZED` | Recording-only operation used on finished live buffer |
| `SEGMENT_SLICE_INVALID` | Invalid slice range |
| `SEGMENT_SPOOL_UNAVAILABLE` | `fullIfSpooled` requested but spool unavailable |
| `SEGMENT_SPOOL_WRITE_FAILED` | Spool write failed in prior live stage |
| `SEGMENT_SPOOL_READ_FAILED` | Spool read failed |
| `SEGMENT_SPOOL_CORRUPTED` | Spool content is corrupted |
| `SEGMENT_INTERNAL_ERROR` | Generic native failure |

---

## See also

- [Pipeline segment buffers — live / streaming](segmentbuffer-streaming.md)
- [Voice Activity Detection (streaming)](vad-streaming.md)
