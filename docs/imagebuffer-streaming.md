# Pipeline image buffers — live / streaming (`imagebuffer`)

## Introduction

**Live** native image buffers: a compressed JPEG/WebP/HEIC ring plus optional session spool, file or base64 ingest, and a lifecycle **`recording` → `finished`**. Used to collect stills, then run the same **offline** OCR / FrameView / export path after finalize.

**Import path:** `react-native-sherpa-onnx/imagebuffer`

For lazy file-backed albums, see [Pipeline image buffers — offline](imagebuffer-offline.md). After **`finalizeLiveImageBuffer`**, the same id is a **finished** live buffer and is accepted by the offline APIs.

| Constraint | Effect on API use |
| --- | --- |
| **Compressed frames only** | Append/ingest stores JPEG/WebP/HEIC bytes. There is no public JS RGB pixel push. |
| **OCR / FrameView / export after finish** | Recording rejects with `ERR_IMAGE_INVALID_STATE`. Same C++ kernel as offline (`GetFrameRgbPtr`). |
| **No native camera ingest yet** | Use `appendLiveImageFrame` (camera JPEG from JS) or `ingestFileToLiveImageBuffer`. ImageReader / AVFoundation is a follow-up, as with VideoBuffer camera. |

---

## Concepts

| Kind | Id prefix | State | Typical use |
| --- | --- | --- | --- |
| **[Offline buffer](imagebuffer-offline.md)** | `img_off_<uuid>` | `immutable` or `lazy` | Batch OCR, PDF slider, file album. |
| **[Live buffer](imagebuffer-streaming.md)** | `img_live_<uuid>` | `recording` → `finished` | Collect stills; finalize → treat as offline. |

**Offline and live work together:** append or ingest → live id → `finalizeLiveImageBuffer` → pass the **finished** ref into [offline](imagebuffer-offline.md) OCR / FrameView / export.

**Why this is fast:** JS sends **ids and compressed blobs**. RGB is decoded on demand into a small hot cache. JS events carry metadata (`frameCount`, `totalFramesWritten`), not pixels.

---

## `info` lifecycle (live buffers)

`LiveImageBufferRef.info` is **not** a live view of native state.

| When | What `info` means |
| --- | --- |
| **`createEmptyLiveImageBuffer`** | Snapshot at creation (`state: 'recording'`, `frameCount: 0`). |
| **While recording** | Stale unless you call `getPipelineImageBufferInfo`. Prefer **`subscribeLiveImageBufferEvents`**. `append` / `ingest` return a fresh info snapshot. |
| **`finalizeLiveImageBuffer`** | Returns **`LiveImageBufferFinishedRef`** with **fresh** `info` (`state: 'finished'`). Use this — not the recording ref’s cached `info`. |
| **Any time** | `getPipelineImageBufferInfo` re-queries native metadata. |

While `state === 'recording'`, the window is the **ring** (and spool when retention is `session`). Evicted ring frames with `retention: 'none'` → `ERR_IMAGE_FRAME_EVICTED`.

---

## Quick start

```ts
import {
  appendLiveImageFrame,
  createEmptyLiveImageBuffer,
  finalizeLiveImageBuffer,
  getPipelineImageBufferInfo,
  ingestFileToLiveImageBuffer,
  releasePipelineImageBuffer,
  subscribeLiveImageBufferEvents,
} from 'react-native-sherpa-onnx/imagebuffer';

const live = await createEmptyLiveImageBuffer({
  ringFrames: 16,
  retention: 'session',
});

const stopEvents = subscribeLiveImageBufferEvents(live, (e) => {
  if (e.type === 'framesAppended') console.log('frames', e.frameCount, e.totalFramesWritten);
  if (e.type === 'overflow') console.warn('ring evicted a frame');
  if (e.type === 'finished') console.log('finalized', e.frameCount);
});

await ingestFileToLiveImageBuffer({ kind: 'fs', path: '/tmp/frame.jpg' }, live);
await appendLiveImageFrame(live, jpegBase64);

const recordingInfo = await getPipelineImageBufferInfo(live);

const finished = await finalizeLiveImageBuffer(live);
stopEvents();

// finished is a valid OfflineImageBufferIdSource for OCR / FrameView / export
await releasePipelineImageBuffer(finished);
```

Pattern: **create empty → subscribe → append/ingest → finalize → offline APIs → release**.

---

## API reference

Exported from `react-native-sherpa-onnx/imagebuffer`. Create returns **`LiveImageBufferRef`** (`info` + recording handle). Live arguments accept **`LiveImageBufferIdSource`**: ref, recording/finished handle, or string id. Prefer the buffer ref; malformed string ids reject with `ERR_IMAGE_INVALID_ARGUMENT`.

### Offline APIs on a live buffer

After **`finalizeLiveImageBuffer`**, the same `img_live_*` id is a valid **`OfflineImageBufferIdSource`**. These functions are documented in [imagebuffer-offline.md](imagebuffer-offline.md) and are not repeated here:

| Function | On a live buffer |
| --- | --- |
| [`getOfflineImageBufferFrameInfo`](imagebuffer-offline.md#getofflineimagebufferframebuffer-frameindex) | Finished only. Recording → `ERR_IMAGE_INVALID_STATE`. |
| [`ensureOfflineImageBufferFrame`](imagebuffer-offline.md#ensureofflineimagebufferframebuffer-frameindex) | Finished only. Recording → `ERR_IMAGE_INVALID_STATE`. |
| [`exportOfflineImageBufferFrame`](imagebuffer-offline.md#exportofflineimagebufferframebuffer-frameindex-output-options) | Finished only. Recording → `ERR_IMAGE_INVALID_STATE`. |
| [`OfflineImageBufferFrameView`](imagebuffer-offline.md#offlineimagebufferframeview) | Finished only. Recording → `ERR_IMAGE_INVALID_STATE`. |
| [`OfflineImageBufferAnnotatedView`](imagebuffer-offline.md#offlineimagebufferannotatedview) | Finished only. Recording → `ERR_IMAGE_INVALID_STATE`. |
| [`releaseOfflineImageBuffer`](imagebuffer-offline.md#releaseofflineimagebufferbuffer) | Recording or finished (same as `releasePipelineImageBuffer`). |
| [Offline OCR `recognize`](ocr-offline.md) | Finished only. Recording → `ERR_IMAGE_INVALID_STATE`. |

`getOfflineImageBufferInfo` is **offline-only** (`img_off_*`). For live ids use [`getPipelineImageBufferInfo`](#getpipelineimagebufferinfobuffer).

### Live create / ingest

#### `createEmptyLiveImageBuffer(options?)`

```ts
function createEmptyLiveImageBuffer(
  options?: CreateEmptyLiveImageBufferOptions
): Promise<LiveImageBufferRef>;
```

```ts
const live = await createEmptyLiveImageBuffer({
  ringFrames: 16,
  retention: 'session',
});
```

Opens an empty live buffer (`img_live_*`, `state: 'recording'`, `frameCount: 0`). `ringFrames` (default `16`) is how many last compressed frames stay in RAM. `retention: 'session'` (default) keeps earlier frames so finish / OCR can see more than the ring; `'none'` keeps only the ring — evicted indexes then reject with `ERR_IMAGE_FRAME_EVICTED`.

#### `appendLiveImageFrame(live, compressedBase64)`

```ts
function appendLiveImageFrame(
  live: LiveImageBufferIdSource,
  compressedBase64: string
): Promise<LiveImageBufferInfo>;
```

```ts
const info = await appendLiveImageFrame(live, jpegBase64);
console.log(info.frameCount, info.totalFramesWritten);
```

Adds one compressed JPEG/WebP/HEIC still (base64) to a **recording** buffer and returns a fresh info snapshot. Empty blobs reject with `ERR_IMAGE_INVALID_ARGUMENT`. After finalize this rejects with `ERR_IMAGE_INVALID_STATE`. There is no public RGB pixel push.

#### `ingestFileToLiveImageBuffer(source, live)`

```ts
function ingestFileToLiveImageBuffer(
  source: FileSource,
  live: LiveImageBufferIdSource
): Promise<LiveImageBufferInfo>;
```

```ts
const info = await ingestFileToLiveImageBuffer(
  { kind: 'fs', path: '/tmp/frame.jpg' },
  live
);
```

Reads one [`FileSource`](fileio.md) and appends its bytes as a compressed frame. Same contract as `appendLiveImageFrame`: recording only, returns a fresh info snapshot.

### Lifecycle / events

#### `finalizeLiveImageBuffer(live)`

```ts
function finalizeLiveImageBuffer(
  live: LiveImageBufferIdSource
): Promise<LiveImageBufferFinishedRef>;
```

```ts
const finished = await finalizeLiveImageBuffer(live);
console.log(finished.info.state, finished.info.frameCount);
```

Ends recording **once** (`recording` → `finished`). The id stays `img_live_*`. Use the returned ref (fresh `info`) as an [`OfflineImageBufferIdSource`](imagebuffer-offline.md) for OCR / FrameView / export. A second finish, or append/ingest after finish, rejects with `ERR_IMAGE_INVALID_STATE`.

#### `subscribeLiveImageBufferEvents(live, onEvent)`

```ts
function subscribeLiveImageBufferEvents(
  live: LiveImageBufferIdSource,
  onEvent: (event: LiveImageBufferEvent) => void
): () => void;
```

```ts
const stop = subscribeLiveImageBufferEvents(live, (e) =>
  console.log(e.type, e.frameCount)
);
```

Listens for `framesAppended`, `overflow`, and `finished` on this buffer. Call the returned function to unsubscribe. Prefer this over polling `info` while recording; `overflow` means a ring eviction on append.

### Inspect / release

#### `getPipelineImageBufferInfo(buffer)`

```ts
function getPipelineImageBufferInfo(
  buffer: PipelineImageBufferIdSource
): Promise<PipelineImageBufferInfo>;
```

```ts
const info = await getPipelineImageBufferInfo(live);
console.log(info.state, info.frameCount, info.totalFramesWritten);
```

Re-queries native metadata for an offline or live id. `live.info` from create goes stale — use this, the snapshot from append/ingest, or the ref from finalize. See [`info` lifecycle](#info-lifecycle-live-buffers).

**Returns** (`LiveImageBufferInfo` when the id is `img_live_*`)

| Field | Meaning |
| --- | --- |
| `kind` / `state` | `'liveImageBuffer'` / `'recording'` \| `'finished'`. |
| `frameCount` | Frames currently indexed (ring, or spool when `session`). |
| `totalFramesWritten` | Session total, including evicted prefix. |
| `ringEvictedFrames` | Frames that left the RAM ring. |
| `hasActiveSpool` | `true` when retention is `'session'`. |

#### `releasePipelineImageBuffer(buffer)`

```ts
function releasePipelineImageBuffer(
  buffer: PipelineImageBufferIdSource
): Promise<void>;
```

```ts
await releasePipelineImageBuffer(finished);
```

Releases an offline or live buffer. [`releaseOfflineImageBuffer`](imagebuffer-offline.md#releaseofflineimagebufferbuffer) does the same for both prefixes. Call when you are done with the id.

---

## Errors

| Code | When |
| --- | --- |
| `ERR_IMAGE_INVALID_ARGUMENT` | Malformed id, empty blob, missing FileSource. |
| `ERR_IMAGE_INVALID_STATE` | Ensure/OCR/export while recording; finish twice; append after finish. |
| `ERR_IMAGE_FRAME_EVICTED` | Index left the ring and there is no spool (`retention: 'none'`). |
| `ERR_IMAGE_BUFFER_NOT_FOUND` | Unknown or already released id. |
| `ERR_IMAGE_WEBP_DISABLED` | WebP decode after finish when libwebp is not linked. |
| `ERR_IMAGE_FORMAT_UNSUPPORTED` | HEIC without the platform hook (host tests). |

---

## Host tests

`imagebuffer_host_test` (`test/cpp/imagebuffer/imagebuffer_live_test.cpp`) is the contract: `img_live_` prefix, ring eviction, finish-once, `GetFrameRgbPtr` decode-once, session vs `none` retention, recording Ensure/GetPtr rejected.
