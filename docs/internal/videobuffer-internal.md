# VideoBuffer — internal notes

Public API: [docs/videobuffer.md](../videobuffer.md). Implementation plan: [videobuffer-implementation-plan.md](./videobuffer-implementation-plan.md).

## Storage

- **Offline:** the file is the source of truth. Create indexes with FFmpeg `libavformat` only (`HAVE_FFMPEG`). MP4/MOV: full sample table at open (`frameCountExact`). Matroska: Cues = keyframes; GOP packets filled on first read.
- **Decoded cache:** NV12 slots in a `FrameSlab` (64-byte align; RAM below mmap threshold, file-backed `MAP_SHARED` above). RGB24 converted once per (frame, size, rotation) under budget. Gray8 is the Y plane.
- **Live ring:** newest HW-encoded H.264 packets in RAM. GOP-granular eviction by bytes and seconds; never splits a GOP.
- **Live spool:** append-only `.vbsp` when retention ≠ `none`. Not MP4 — avformat cannot follow a growing file.

## `.vbsp` v1

Each segment starts at a keyframe.

- File header: magic `VBSP`, version, codec, codec config, track info.
- Record: `[magic u32 VBRC][len u32][pts i64][dts i64][flags u32][crc32 u32][payload]`.

Recovery: scan records, stop at the first bad length/CRC, truncate to the last complete GOP. `ENOSPC` → ring-only + `spoolError`. Overflow → drop-to-next-key + discontinuity.

Retention:

| Mode | Files |
| --- | --- |
| `session` (default) | Temp spool under `sherpa-video`, deleted on release |
| `none` | Ring only |
| `maxSeconds` | Rolling: delete oldest segments |
| `path` | Caller-owned directory |

## Invariants

- Live state is CAS `recording → finished`, never back.
- Decoder never receives a non-key first packet.
- Same-GOP forward seek does not flush.
- Pinned frame leases survive LRU eviction and `Release()` until the last lease drops.
- Display matrix rot90 maps to transform **270** (clockwise display).
- Color convert goes only through libyuv (`ColorConvert`). libyuv RGB24 is BGR; wrappers account for that.
- HW decode/encode only: Android `AMediaCodec` + `AImageReader` YUV_420_888; iOS `VideoToolbox`. Software `c2.android.*` / `OMX.google.*` are excluded.

## Ids and cache

- Offline: `vid_off_<uuid>`
- Live: `vid_live_<uuid>`
- Cache dir: Android `context.cacheDir/sherpa-video`; iOS `NSTemporaryDirectory()/sherpa-video`.
- Orphan sweep on init.

## Host tests

- `videobuffer_core_host_test` — no FFmpeg; `FakeDecoderBackend`; synthetic streams.
- `videobuffer_demux_host_test` — system libav; fixtures under `test/fixtures/videobuffer/`.
- Sanitizers: `-DVIDEOBUFFER_SANITIZE=address` (ASan+UBSan) or `=thread` (TSan) on the core executable.
- Optional `videobuffer_vt_host_test` on macOS.
