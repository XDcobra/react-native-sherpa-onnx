# LiveImageBuffer — internal invariants

Public API: [imagebuffer-offline.md](../../imagebuffer-offline.md), [imagebuffer-streaming.md](../../imagebuffer-streaming.md).

Shared C++ kernel with offline: `ImageDecoder` + packed RGB8 on `GetFrameRgbPtr`. Orchestration differs: `LiveImageEntry` (compressed ring + optional session spool) vs offline slots.

## Ids

- Offline: `img_off_<uuid>`
- Live: `img_live_<uuid>` — **stays** after `Finish()`. No rewrite to `img_off_`.

## State

- CAS `recording → finished`, never back.
- `Finish()` when not recording → `ERR_IMAGE_INVALID_STATE`.
- `AppendCompressed` after finish → `ERR_IMAGE_INVALID_STATE`.
- Consumer `EnsureFrame` / `GetFrameRgbPtr` / OCR / FrameView / export while **recording** → `ERR_IMAGE_INVALID_STATE` (pointer is null).

## Ring and spool

- Ring holds the last N **compressed** JPEG/WebP/HEIC frames (default `ringFrames = 16`). Evict whole frames from the front (no GOP).
- Retention `session` (default): spool keeps every appended frame for the JS session. Finish/OCR can still `EnsureFrame(0)` after the ring wrapped.
- Retention `none`: ring only. Evicted index → `ERR_IMAGE_FRAME_EVICTED`.
- RGB is a small hot LRU (`hotFrames`, default 8), decoded on demand through the same `ImageDecoder` (WebP `use_scaling`, HEIC platform hook).

## Pointer lifetime

`GetFrameRgbPtr` is valid until `Release()` or hot-cache eviction of that frame. Same contract as offline ImageBuffer. Host tests: first Get decodes once; second Get is a cache hit (`LiveDecodeCount`).

## Events

JS metadata only (`SherpaOnnxImageLiveEvent`): `framesAppended`, `overflow` (ring eviction on append), `finished`. No pixels.

## Host tests

`test/cpp/imagebuffer/imagebuffer_live_test.cpp` via `imagebuffer_host_test`.
