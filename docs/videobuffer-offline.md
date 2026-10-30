# Pipeline video buffers — offline (`videobuffer`)

## Introduction

**Immutable offline clips:** one file-backed video (index + on-demand HW decode). Used as input for **batch** OCR (via ImageBuffer), STT (via AudioBuffer), frame export, and [Video preview](videopreview.md).

**Import path:** `react-native-sherpa-onnx/videobuffer`

For rolling ingest (`recording` → `finished`), see [Pipeline video buffers — live / streaming](videobuffer-streaming.md). A **finished** live buffer is accepted by the offline APIs on this page.

| Constraint | Effect on API use |
| --- | --- |
| **HW decode only** | Frame access (image bridge, export, preview) needs a device HW codec (H.264 / HEVC). Typical Android emulator has none → `VIDEO_DECODER_UNAVAILABLE` / `VIDEO_CODEC_UNSUPPORTED`. Opening the file still succeeds. |
| **FFmpeg required to open a file** | `createOfflineVideoBufferFromFile` rejects with `VIDEO_FFMPEG_DISABLED` when FFmpeg is compiled out. See [disable-ffmpeg.md](disable-ffmpeg.md). |
| **Time axis** | Video times are **microseconds** (`ptsUs`, `fromUs` / `toUs`, `timesUs`, `seekableStartUs`). Audio extract uses **milliseconds** (`rangeMs`). OCR spans use **milliseconds** (`ptsMs`, derived from the frame’s `source.ptsUs`). |

---

## Concepts

| Kind | Id prefix | State | Typical use |
| --- | --- | --- | --- |
| **[Offline buffer](videobuffer-offline.md)** | `vid_off_<uuid>` | `immutable` | Batch OCR/STT, frame export, preview of a completed take. |
| **[Live buffer](videobuffer-streaming.md)** | `vid_live_<uuid>` | `recording` → `finished` | Camera / file ingest, live preview, then **finalize** and reuse as offline. |

**Offline and live work together:** both use **stable buffer ids**. Pass a **finished** live ref (`LiveVideoBufferFinishedRef`) into `createOfflineImageBufferFromVideo` / `createOfflineAudioBufferFromVideo` / `exportVideoFrame` / preview. While `recording`, use the [live](videobuffer-streaming.md) APIs.

**Why this is fast:** apps pass **ids**; frames and PCM stay native. Decode happens on demand, not as a full RGB dump through the JS bridge.

| Containers | Video codecs (v1) | Rejects |
| --- | --- | --- |
| MP4, MOV, M4V, 3GP, MKV, WebM | H.264, HEVC | Other video codecs → `VIDEO_CODEC_UNSUPPORTED`. Audio-only → `VIDEO_NO_VIDEO_TRACK`. Unsupported container → `VIDEO_CONTAINER_UNSUPPORTED`. |

---

## Quick start

Typical batch job: open a clip, inspect it, sample frames for OCR, export one still, extract audio for STT, then release.

```ts
import {
  configureVideoBuffer,
  createOfflineAudioBufferFromVideo,
  createOfflineImageBufferFromVideo,
  createOfflineVideoBufferFromFile,
  exportVideoFrame,
  getVideoBufferInfo,
  getVideoKeyframeTimes,
  releaseVideoBuffer,
} from 'react-native-sherpa-onnx/videobuffer';
import {
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

// Global HW decode slots: `cpu` = OCR / export; `display` = preview. Each 1–4 (default 1).
await configureVideoBuffer({ decoderBudget: { cpu: 1, display: 1 } });

// Open a local filesystem path. Needs FFmpeg. Pixels are not decoded yet.
const video = await createOfflineVideoBufferFromFile('/tmp/clip.mp4');

// Fresh native metadata. Offline clips are immutable; `video.info` from create is enough,
// but this is the same call you use for live buffers.
const info = await getVideoBufferInfo(video);
console.log(info.kind, info.frameCount, info.audio?.codec, info.audio?.decodable);

const fromUs = info.seekableStartUs ?? 0;
const toUs = info.seekableEndUs ?? fromUs;
// Keyframe PTS list (µs) in [fromUs, toUs], capped by maxCount (default 64).
const keys = await getVideoKeyframeTimes(video, { fromUs, toUs }, 256);

// Sample ~2 fps into an ImageBuffer (longest edge capped). Returns an id, not a full ref.
const images = await createOfflineImageBufferFromVideo(video, {
  sampling: 'fps',
  fps: 2,
  maxSide: 1280,
});
const frame0 = await getOfflineImageBufferFrameInfo(images.imageBufferId, 0);
console.log(frame0.source?.ptsUs, frame0.source?.frameIndex); // OCR spans get ptsMs from this

// One JPEG at a chosen PTS (first keyframe, or 0). Destination is FileDestination (fileio).
const still = await exportVideoFrame(
  video,
  keys[0] ?? fromUs,
  { kind: 'fs', path: '/tmp/frame.jpg' },
  { format: 'jpeg', maxSide: 1280, quality: 90 }
);

// Audio → AudioBuffer. Default 16 kHz; `0` keeps the source rate. Optional range + cancel.
const controller = new AbortController();
const extract = await createOfflineAudioBufferFromVideo(video, {
  targetSampleRateHz: 16000,
  rangeMs: { startMs: 0, endMs: (toUs - fromUs) / 1000 },
  onProgress: (e) => console.log(e.percent, e.decodedMs),
  signal: controller.signal,
});
console.log(extract.mediaStartMs, extract.sourceCodec, extract.audio.info.sampleRate);
// pass extract.audio into offline STT / enhancement

await releaseVideoBuffer(video);
await releaseOfflineImageBuffer(images.imageBufferId);
await releasePipelineAudioBuffer(extract.audio);
```

Pattern: **open once → pass the ref/id into OCR / STT / export / preview → release**.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/videobuffer`. Buffer arguments accept `OfflineVideoBufferIdSource` (ref, handle, finished live ref/handle, or string) unless noted.

Ref-first usage is recommended. Malformed ids reject early with `VIDEO_INVALID_ARGUMENT`.

### General

#### `getVideoBufferInfo(buffer)`

```ts
function getVideoBufferInfo(
  buffer: PipelineVideoBufferIdSource
): Promise<PipelineVideoBufferInfo>;
```

```ts
const info = await getVideoBufferInfo(video);
```

Works for **live** buffers too (`kind: 'liveVideoBuffer'`). For a recording live buffer, `ref.info` from create is only a snapshot — see [info lifecycle](videobuffer-streaming.md#info-lifecycle-live-buffers).

| Field (offline) | Meaning |
| --- | --- |
| `kind` / `state` | `'offlineVideoBuffer'` / `'immutable'`. |
| `frameCount` | Indexed presentation frames. |
| `seekableStartUs` / `seekableEndUs` | Inclusive seek window (µs). Use these for `getVideoKeyframeTimes` and `timesUs`. |
| `audio` | `null` if no track. Otherwise codec, rate, channels, `decodable`. Missing audio is not an error. |

| `audio` field | Meaning |
| --- | --- |
| `codec` | Container codec name (`aac`, `opus`, `ac3`, …). |
| `decodable` | `false` → extract / preview audio will fail (`VIDEO_AUDIO_CODEC_UNSUPPORTED`). Typical for AC-3, DTS, ALAC. |
| `sampleRate` / `channels` | Source track. |
| `startMs` / `durationMs` | Track timing on the video timeline. |

#### `getVideoKeyframeTimes(buffer, range, maxCount?)`

```ts
function getVideoKeyframeTimes(
  buffer: PipelineVideoBufferIdSource,
  range: { fromUs: number; toUs: number },
  maxCount?: number
): Promise<number[]>;
```

```ts
const ptsUs = await getVideoKeyframeTimes(video, { fromUs: 0, toUs: 10_000_000 }, 256);
```

PTS of keyframes in **microseconds**, ascending, clipped to `[fromUs, toUs]`.

| Parameter | Default | Effect |
| --- | --- | --- |
| `range.fromUs` / `range.toUs` | required | Inclusive window. Outside the seekable range yields fewer / no keys. |
| `maxCount` | `64` | Hard cap. Raise it for long clips if you need a denser key list (scrub, `sampling: 'times'`). |

#### `releaseVideoBuffer(buffer)`

```ts
function releaseVideoBuffer(buffer: PipelineVideoBufferIdSource): Promise<void>;
```

```ts
await releaseVideoBuffer(video);
```

Invalidates the id. Preview players attached to this buffer must be released first (see [videopreview.md](videopreview.md)).

#### `configureVideoBuffer(options?)`

```ts
function configureVideoBuffer(options?: ConfigureVideoBufferOptions): Promise<void>;
```

```ts
await configureVideoBuffer({ decoderBudget: { cpu: 2, display: 1 } });
```

Process-wide HW decoder slots. Values are integers **1–4**. Omitted fields keep the current value. Default is `{ cpu: 1, display: 1 }`.

| Class | Used by | When the budget is exhausted |
| --- | --- | --- |
| `cpu` | `createOfflineImageBufferFromVideo`, `exportVideoFrame`, OCR decode | Decode fails (`VIDEO_DECODE_FAILED` / related). |
| `display` | [Video preview](videopreview.md) | `VIDEO_PREVIEW_DECODER_BUSY` (audio-only play still allowed). |

Raise `cpu` if you run OCR sampling and export in parallel. Raise `display` only if several preview players decode at once.

### Offline buffer

#### `createOfflineVideoBufferFromFile(path)`

```ts
function createOfflineVideoBufferFromFile(path: string): Promise<OfflineVideoBufferRef>;
```

```ts
const video = await createOfflineVideoBufferFromFile('/tmp/clip.mp4');
```

`path` is a local filesystem path (not a content URI). Needs FFmpeg. Does not decode pixels at create time.

| Result | Notes |
| --- | --- |
| `video.bufferId` | Branded id (`vid_off_…`). Pass the **ref** into other APIs. |
| `video.info` | Creation snapshot (`kind`, `frameCount`, seekable window, `audio`). |

#### `createOfflineImageBufferFromVideo(video, options?)`

```ts
function createOfflineImageBufferFromVideo(
  video: OfflineVideoBufferIdSource,
  options?: CreateOfflineImageFromVideoOptions
): Promise<{ imageBufferId: string; frameCount: number }>;
```

```ts
const images = await createOfflineImageBufferFromVideo(video, { sampling: 'fps', fps: 2, maxSide: 1280 });
```

Copies sampled frames into an [offline ImageBuffer](imagebuffer-offline.md). Pass `images.imageBufferId` to OCR / `getOfflineImageBufferFrameInfo`. Each frame may include `source: { videoBufferId, ptsUs, frameIndex }` — OCR fills `TextSpatialSpan.ptsMs` from that PTS. Accepts **offline** and **finished live**. Recording live → `VIDEO_BUFFER_INVALID_STATE`.

Release with `releaseOfflineImageBuffer` from `react-native-sherpa-onnx/imagebuffer`.

| `sampling` | Extra fields | Frames taken |
| --- | --- | --- |
| `'all'` (default) | — | Every decoded frame. |
| `'keyframes'` | — | Keyframes only. |
| `'fps'` | `fps` (required) | ~`fps` frames per second of **video time**. |
| `'uniform'` | `uniformCount` (required) | `uniformCount` frames spread across the duration. |
| `'times'` | `timesUs` (required) | Nearest frame at each PTS (µs). |

| Option | Default | Effect |
| --- | --- | --- |
| `maxSide` | no cap (`0`) | Longest edge of the RGB copy; use to bound OCR / RAM. |

#### `exportVideoFrame(video, ptsUs, destination, options?)`

```ts
function exportVideoFrame(
  video: OfflineVideoBufferIdSource,
  ptsUs: number,
  destination: FileDestination,
  options?: ExportVideoFrameOptions
): Promise<ResolvedFileRef>;
```

```ts
const file = await exportVideoFrame(video, 0, { kind: 'fs', path: '/tmp/frame.jpg' }, { format: 'jpeg' });
```

Decodes the nearest frame at `ptsUs` and writes it via [fileio](fileio.md). Accepts **offline** and **finished live**. `ptsUs` outside the clip → `VIDEO_FRAME_OUT_OF_RANGE`.

| Option | Default | Effect |
| --- | --- | --- |
| `format` | `'jpeg'` | `'jpeg'` \| `'png'` \| `'webp'`. WebP needs libwebp enabled ([imagebuffer-offline.md](imagebuffer-offline.md)). |
| `quality` | encoder default | JPEG/WebP quality. |
| `maxSide` | no cap | Longest-edge cap before encode. |

#### `createOfflineAudioBufferFromVideo(video, options?)`

```ts
function createOfflineAudioBufferFromVideo(
  video: OfflineVideoBufferIdSource,
  options?: CreateOfflineAudioFromVideoOptions
): Promise<VideoAudioExtractResult>;
```

```ts
const { audio, mediaStartMs } = await createOfflineAudioBufferFromVideo(video, { targetSampleRateHz: 16000 });
```

Decodes the container audio track into an [offline AudioBuffer](audiobuffer-offline.md). Needs FFmpeg. Accepts **offline** and **finished live**. Recording live → `VIDEO_BUFFER_INVALID_STATE` (use `createLiveAudioBufferFromLiveVideo`).

No audio track → `VIDEO_NO_AUDIO_TRACK`. `info.audio.decodable === false` → `VIDEO_AUDIO_CODEC_UNSUPPORTED`.

| Option | Default | Effect |
| --- | --- | --- |
| `targetSampleRateHz` omitted | `16000` | Resample to 16 kHz (STT default). |
| `targetSampleRateHz: 0` | — | Keep the source rate. |
| `targetSampleRateHz > 0` | — | Exact output rate. |
| `rangeMs` | full track | `{ startMs, endMs }` on the **video** timeline (`endMs > startMs`). |
| `onProgress` | — | `{ percent, decodedMs }`. |
| `signal` | — | Abort → `VIDEO_CANCELLED`. |

| Result field | Meaning |
| --- | --- |
| `audio` | Offline AudioBuffer ref to pass into STT / enhancement. Release with `releasePipelineAudioBuffer`. |
| `mediaStartMs` | Video-timeline time of PCM sample 0 (edit list, late audio, or `rangeMs.startMs`). |
| `sourceCodec` / `sourceSampleRate` / `sourceChannels` | Container track before resample. |

Preview playback of the same track is a separate API (`react-native-sherpa-onnx/videopreview`); it does not play through this AudioBuffer.

---

## Types and constants

Canonical TypeScript types: [`src/videobuffer/types.ts`](../src/videobuffer/types.ts).

| Name | Role |
| --- | --- |
| `OfflineVideoBufferHandle` | Branded string id (`vid_off_…`). |
| `OfflineVideoBufferRef` | `{ bufferId, info }` from create. |
| `OfflineVideoBufferIdSource` | Ref, handle, raw id, **or** finished live ref/handle. |
| `PipelineVideoBufferIdSource` | Offline **or** live (recording / finished). |
| `OfflineVideoBufferInfo` | Metadata (`kind: 'offlineVideoBuffer'`, `state: 'immutable'`). |
| `VideoAudioTrackInfo` | `codec`, `decodable`, `sampleRate`, `channels`, `startMs`, `durationMs`. |
| `CreateOfflineImageFromVideoOptions` | `sampling`, `fps`, `uniformCount`, `timesUs`, `maxSide`. |
| `ExportVideoFrameOptions` | `format`, `maxSide`, `quality`. |
| `CreateOfflineAudioFromVideoOptions` | `targetSampleRateHz`, `rangeMs`, `onProgress`, `signal`. |
| `VideoAudioExtractResult` | `{ audio, mediaStartMs, sourceCodec, sourceSampleRate, sourceChannels }`. |
| `ConfigureVideoBufferOptions` | `{ decoderBudget?: { cpu?, display? } }`. |

---

## Error codes

Thrown / rejected as `VIDEO_…` (`Error` message `VIDEO_…: …`, native reject code the same).

| Code | Typical cause |
| --- | --- |
| `VIDEO_INVALID_ARGUMENT` | Malformed id, bad `decoderBudget`, `rangeMs`, sampling fields. |
| `VIDEO_BUFFER_NOT_FOUND` | Released or unknown id. |
| `VIDEO_BUFFER_KIND_MISMATCH` | Live recording passed where an offline/finished clip is required. |
| `VIDEO_BUFFER_INVALID_STATE` | Offline extract/export on a **recording** live buffer. |
| `VIDEO_FFMPEG_DISABLED` | File open or audio extract with FFmpeg compiled out. |
| `VIDEO_CONTAINER_UNSUPPORTED` | Container not in the v1 set. |
| `VIDEO_NO_VIDEO_TRACK` | Audio-only file. |
| `VIDEO_NO_AUDIO_TRACK` | Extract audio but the clip has no audio. |
| `VIDEO_CODEC_UNSUPPORTED` | Video codec not H.264/HEVC, or no HW decoder. |
| `VIDEO_AUDIO_CODEC_UNSUPPORTED` | Audio codec not in the SDK FFmpeg build. |
| `VIDEO_DECODER_UNAVAILABLE` | No HW video decoder (emulator). |
| `VIDEO_DECODE_FAILED` | HW decode error on a frame. |
| `VIDEO_AUDIO_DECODE_FAILED` | Audio extract produced no PCM in range / decode error. |
| `VIDEO_FRAME_OUT_OF_RANGE` | `ptsUs` / `timesUs` outside the clip. |
| `VIDEO_FILE_CORRUPT` | Demux/index failed. |
| `VIDEO_CANCELLED` | `signal` aborted audio extract. |
| `VIDEO_MEMORY_BUDGET_EXCEEDED` | Decode/RGB copy exceeded the process budget. |

Preview-only codes (`VIDEO_PREVIEW_…`) are documented in [videopreview.md](videopreview.md).

---

## See also

- [Pipeline video buffers — live / streaming](videobuffer-streaming.md)
- [Video preview](videopreview.md)
- [Pipeline image buffers — offline](imagebuffer-offline.md) (`source.ptsUs` on sampled frames)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [OCR — offline](ocr-offline.md)
- [fileio.md](fileio.md) (`FileDestination` / `ResolvedFileRef`)
- [Disabling FFmpeg](disable-ffmpeg.md)

---

<details>
<summary>Use case examples</summary>

**OCR a clip at 2 fps, keep timestamps**

```ts
const video = await createOfflineVideoBufferFromFile(path);
const images = await createOfflineImageBufferFromVideo(video, {
  sampling: 'fps',
  fps: 2,
  maxSide: 1280,
});
const page = await ocr.recognize(images.imageBufferId, textOut, { granularity: 'line' });
// spans on `textOut` include ptsMs from each frame’s source PTS
```

**STT a time range**

```ts
const { audio, mediaStartMs } = await createOfflineAudioBufferFromVideo(video, {
  targetSampleRateHz: 16000,
  rangeMs: { startMs: 5_000, endMs: 25_000 },
});
const text = await recognizer.recognize(audio);
```

**Still at a keyframe for sharing**

```ts
const keys = await getVideoKeyframeTimes(video, { fromUs, toUs }, 64);
const file = await exportVideoFrame(video, keys[3] ?? fromUs, {
  kind: 'fs',
  path: '/tmp/poster.jpg',
});
```

</details>

---

## Native crash diagnostics

If the process dies in native code (TOCTOU, use-after-release), capture a tombstone / logcat crash dump and include it with the buffer ids and the API sequence (create → OCR/export/extract → release).
