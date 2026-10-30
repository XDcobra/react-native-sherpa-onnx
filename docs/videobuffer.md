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

## Audio track and pipeline export

Offline (and finished live) buffers expose `info.audio` when a container audio stream exists:

```ts
{
  codec: string;       // "aac", "opus", "ac3", …
  decodable: boolean;  // decoder present in this FFmpeg build
  sampleRate: number;
  channels: number;
  startMs: number;
  durationMs: number;
}
```

`decodable` is false for codecs the SDK FFmpeg is not built with (AC-3, DTS, ALAC, …). Missing audio is `audio: null`, not an error. Audio-only files still fail create with `VIDEO_NO_VIDEO_TRACK`.

Export the track into a normal pipeline AudioBuffer (mono, default 16 kHz) for STT / enhancement:

```ts
import { createOfflineAudioBufferFromVideo } from 'react-native-sherpa-onnx/videobuffer';

const { audio, mediaStartMs, sourceCodec } = await createOfflineAudioBufferFromVideo(offline, {
  targetSampleRateHz: 16000, // omit → 16000; 0 → keep source; > 0 → exact
  rangeMs: { startMs: 0, endMs: 5000 },
  signal,
  onProgress: ({ percent }) => {},
});
```

`mediaStartMs` is the video-timeline time of PCM sample 0 (edit list, late audio, or `rangeMs.startMs`). Recording live buffers reject with `VIDEO_BUFFER_INVALID_STATE` for the offline export; use `createLiveAudioBufferFromLiveVideo` to tap a recording live buffer into a live AudioBuffer. Unsupported codecs reject with `VIDEO_AUDIO_CODEC_UNSUPPORTED`. Preview playback of the same track is a separate API (`react-native-sherpa-onnx/videopreview`); feeding an AudioBuffer into preview is a future option.

File ingest into a live video buffer copies the audio track by default (`includeAudio: true`).

## Player

`getVideoKeyframeTimes`, `seekableRange`, `liveEdgeUs`, and native `VideoPacketReader` feed VideoPreview — see [videopreview.md](./videopreview.md).

## Memory

Decoded-frame and live-ring budgets scale with device RAM class. Memory-pressure callbacks (`onTrimMemory` / iOS memory warnings) shrink caches to pinned frames. Host tests prove the mechanism with tiny synthetic budgets; production MB tables may be retuned after device benches.

## Logging

Stable tag `[SherpaOnnx:video]` (sub-tags `video.demux`, `video.decode`, `video.cache`, `video.live`, `video.spool`). Info/debug is gated by a runtime flag enabled in `__DEV__`.
