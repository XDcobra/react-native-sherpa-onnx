# Pipeline video buffers (`videobuffer`)

Offline and live video buffers for OCR, image export, and a future player. One C++ core on Android and iOS.

**Import path:** `react-native-sherpa-onnx/videobuffer`

Decode and encode are **hardware only** (Android `AMediaCodec`, iOS `VideoToolbox`). There is no silent software fallback. Opening a file still works when FFmpeg is linked; frame access fails with `VIDEO_DECODER_UNAVAILABLE` / `VIDEO_CODEC_UNSUPPORTED` if no HW codec exists (typical Android emulator).

## Concepts

| Kind | Id prefix | State | What it is |
| --- | --- | --- | --- |
| **Offline video buffer** | `vid_off_<uuid>` | `immutable` | Container + index. Nothing is decoded at create. |
| **Live video buffer** | `vid_live_<uuid>` | `recording` → `finished` (never back) | Encoded H.264 ring in RAM; optional durable `.vbsp` spool. A finished live buffer is accepted by every offline API. |

Time axis is **microseconds PTS** after the container edit list. `frameIndex` is presentation-order.

## Create

```ts
import {
  createOfflineVideoBufferFromFile,
  createEmptyLiveVideoBuffer,
  ingestFileToLiveVideoBuffer,
  finalizeLiveVideoBuffer,
  getVideoBufferInfo,
  getVideoKeyframeTimes,
  releaseVideoBuffer,
} from 'react-native-sherpa-onnx/videobuffer';

const offline = await createOfflineVideoBufferFromFile('/path/to/clip.mp4');
const live = await createEmptyLiveVideoBuffer({
  ringSeconds: 10,
  retention: 'session', // or 'none' | { mode: 'maxSeconds', seconds } | { mode: 'path', directory }
});
await ingestFileToLiveVideoBuffer('/path/to/clip.mp4', live, { pacing: 'asFast' });
const finished = await finalizeLiveVideoBuffer(live);
```

Supported containers (FFmpeg `mov` / `matroska` demuxers already in the SDK prebuilts): MP4/MOV/M4V/3GP/MKV/WebM. Codecs v1: **H.264** and **HEVC**. VP9/AV1 → `VIDEO_CODEC_UNSUPPORTED`. Audio-only → `VIDEO_NO_VIDEO_TRACK`.

When FFmpeg is disabled, file create/ingest reject with `VIDEO_FFMPEG_DISABLED`. See [disable-ffmpeg.md](disable-ffmpeg.md). Live buffers filled by a native producer still work.

## Image bridge and OCR

```ts
import { createOfflineImageBufferFromVideo, exportVideoFrame } from 'react-native-sherpa-onnx/videobuffer';

const images = await createOfflineImageBufferFromVideo(offline, {
  sampling: 'keyframes', // 'all' | 'fps' | 'uniform' | 'times'
  maxSide: 640,
});
```

Frames copied into an OfflineImageBuffer keep `source: { videoBufferId, ptsUs, frameIndex }`. OCR on that image buffer fills `TextSpatialSpan.ptsMs` from the source PTS so overlays can sync to video time.

`exportVideoFrame(video, ptsUs, destination, { format, maxSide })` encodes one RGB frame via the image export path.

## Player (not built)

`getVideoKeyframeTimes`, `seekableRange`, `liveEdgeUs`, and native `VideoPacketReader` are prepared for a future `VideoPreview`. The view itself is a later epic.

## Memory

Decoded-frame and live-ring budgets scale with device RAM class. Memory-pressure callbacks (`onTrimMemory` / iOS memory warnings) shrink caches to pinned frames. Host tests prove the mechanism with tiny synthetic budgets; production MB tables may be retuned after device benches.

## Logging

Stable tag `[SherpaOnnx:video]` (sub-tags `video.demux`, `video.decode`, `video.cache`, `video.live`, `video.spool`). Info/debug is gated by a runtime flag enabled in `__DEV__`.
