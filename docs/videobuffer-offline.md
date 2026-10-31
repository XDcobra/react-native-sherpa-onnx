# Pipeline video buffers — offline (`videobuffer`)

## Introduction

**Immutable offline clips:** one file-backed video (index + on-demand HW decode). Used as input for **batch** OCR (via ImageBuffer), STT (via AudioBuffer), frame export, and [Video preview](videopreview.md).

**Import path:** `react-native-sherpa-onnx/videobuffer`

For rolling ingest (`recording` → `finished`), see [Pipeline video buffers — live / streaming](videobuffer-streaming.md). A **finished** live buffer is accepted by the offline APIs on this page.

| Constraint | Effect on API use |
| --- | --- |
| **Decode / encode tiers** | Pixels use the shared codec layer ([codecs.md](codecs.md)). Default policy `preferHardware` (platform HW, then platform SW, then opt-in bundled FFmpeg). Strict `hardware` fails when no HW session is usable. Opening the file still succeeds without a decoder. |
| **FFmpeg required to open a file** | `probeVideoFileDuration`, `probeVideoFileContainer`, `createOfflineVideoBufferFromFile`, and `exportVideo` (mux) reject with `VIDEO_FFMPEG_DISABLED` when FFmpeg is compiled out. JS probe wrappers return `null`. See [disable-ffmpeg.md](disable-ffmpeg.md). |
| **Time axis** | Video times are **microseconds** (`ptsUs`, `fromUs` / `toUs`, `timesUs`, `seekableStartUs`). Audio extract uses **milliseconds** (`rangeMs`). OCR spans use **milliseconds** (`ptsMs`, derived from the frame’s `source.ptsUs`). |

---

## Concepts

| Kind | Id prefix | State | Typical use |
| --- | --- | --- | --- |
| **[Offline buffer](videobuffer-offline.md)** | `vid_off_<uuid>` | `immutable` | Batch OCR/STT, frame export, preview of a completed take. |
| **[Live buffer](videobuffer-streaming.md)** | `vid_live_<uuid>` | `recording` → `finished` | Camera / file ingest, live preview, then **finalize** and reuse as offline. |

**Offline and live work together:** both use **stable buffer ids**. Pass a **finished** live ref (`LiveVideoBufferFinishedRef`) into `createOfflineImageBufferFromVideo` / `createOfflineAudioBufferFromVideo` / `exportVideoFrame` / `exportVideo` / preview. While `recording`, use the [live](videobuffer-streaming.md) APIs.

**Why this is fast:** apps pass **ids**; frames and PCM stay native. Decode happens on demand, not as a full RGB dump through the JS bridge.

---

## Quick start

Typical batch job: open a clip, inspect it, sample frames for OCR, export one still, extract audio for STT, then release.

```ts
import {
  configureVideoBuffer,
  createOfflineAudioBufferFromVideo,
  createOfflineImageBufferFromVideo,
  createOfflineVideoBufferFromFile,
  exportVideo,
  exportVideoFrame,
  getVideoBufferInfo,
  getVideoKeyframeTimes,
  probeVideoFileContainer,
  probeVideoFileDuration,
  releaseVideoBuffer,
} from 'react-native-sherpa-onnx/videobuffer';
import {
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

// Shared codec budgets (1–4). See [codecs.md](./codecs.md).
import { configureCodecs } from 'react-native-sherpa-onnx/codec';
await configureCodecs({ budgets: { hwVideoDecode: 1, hwVideoDisplay: 1 } });

const source = { kind: 'fs' as const, path: '/tmp/clip.mp4' };
// Cheap sniff: duration + container/codec from file bytes. No VideoBuffer, no pixel decode.
const duration = await probeVideoFileDuration(source);
const container = await probeVideoFileContainer(source);
console.log(duration?.durationUs, container?.inputFormatName, container?.codecName);

// Open a FileSource. Needs FFmpeg. Pixels are not decoded yet.
const video = await createOfflineVideoBufferFromFile(source);

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

// Whole-clip HW transcode to a FileDestination. Always re-encodes (no packet-copy remux).
const clip = await exportVideo(
  video,
  { kind: 'fs', path: '/tmp/clip.webm' },
  'webm',
  { codec: 'h264', bitrate: 2_000_000, maxSide: 1280 }
);
console.log(clip.path);

await releaseVideoBuffer(video);
await releaseOfflineImageBuffer(images.imageBufferId);
await releasePipelineAudioBuffer(extract.audio);
```

Pattern: **open once → pass the ref/id into OCR / STT / export / preview → release**.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/videobuffer`. Buffer arguments accept `OfflineVideoBufferIdSource` (ref, handle, finished live ref/handle, or string) unless noted.

Ref-first usage is recommended. Malformed ids reject early with `VIDEO_INVALID_ARGUMENT`.

Tables under each function are labeled **Parameters** (arguments), **`options`** (fields of the options object), or **Returns** (resolved value).

### General

#### `getVideoBufferInfo(buffer)`

```ts
function getVideoBufferInfo(
  buffer: PipelineVideoBufferIdSource
): Promise<PipelineVideoBufferInfo>;
```

```ts
const info = await getVideoBufferInfo(video);
// info ≈ {
//   bufferId: 'vid_off_8f3a…',
//   kind: 'offlineVideoBuffer',
//   state: 'immutable',
//   frameCount: 300,
//   seekableStartUs: 0,
//   seekableEndUs: 10_000_000,
//   audio: {
//     codec: 'aac',
//     decodable: true,
//     sampleRate: 48000,
//     channels: 2,
//     startMs: 0,
//     durationMs: 10000,
//   },
// }
```

Works for **live** buffers too (`kind: 'liveVideoBuffer'`). For a recording live buffer, `ref.info` from create is only a snapshot — see [info lifecycle](videobuffer-streaming.md#info-lifecycle-live-buffers).

**Returns** (`OfflineVideoBufferInfo`)

| Field | Meaning |
| --- | --- |
| `kind` / `state` | `'offlineVideoBuffer'` / `'immutable'`. |
| `frameCount` | Indexed presentation frames. |
| `seekableStartUs` / `seekableEndUs` | Inclusive seek window (µs). Use these for `getVideoKeyframeTimes` and `timesUs`. |
| `audio` | `null` if no track. Otherwise codec, rate, channels, `decodable`. Missing audio is not an error. |

**Returns** `audio` (`VideoAudioTrackInfo | null`)

| Field | Meaning |
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
// ptsUs ≈ [0, 500_000, 1_000_000, 1_500_000, 2_000_000]  // µs, ascending, ≤ maxCount
```

PTS of keyframes in **microseconds**, ascending, clipped to `[fromUs, toUs]`.

**Parameters**

| Argument | Default | Meaning |
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
import { configureCodecs, subscribeCodecEvents } from 'react-native-sherpa-onnx/codec';

await configureCodecs({
  video: { decode: 'preferHardware', encode: 'preferHardware' },
  budgets: { hwVideoDecode: 2, hwVideoDisplay: 1 },
});
subscribeCodecEvents((e) => {
  if (e.type === 'slotFreed') {
    // retry a failed export / decode
  }
});
```

`configureVideoBuffer` remains as a no-op wrapper. Use [`configureCodecs`](./codecs.md) for policies and budgets. Default policy is **`preferHardware`**. Per-buffer / per-call override: `decodePolicy` / `encodePolicy`.

### Offline buffer

#### `probeVideoFileDuration(source)`

```ts
function probeVideoFileDuration(
  source: FileSource
): Promise<VideoFileDurationProbe | null>;
```

```ts
const probe = await probeVideoFileDuration({ kind: 'fs', path: '/tmp/clip.mp4' });
// probe ≈ { durationUs: 8_000_000, isExact: true }
```

Duration from container metadata only (no sample index, no `vid_off_`, no HW decode). Returns `null` on failure (wrapper swallows native `VIDEO_*` rejections). `isExact` is `true` for stream/format duration; `false` when estimated from frame count or bitrate × file size.

#### `probeVideoFileContainer(source)`

```ts
function probeVideoFileContainer(
  source: FileSource
): Promise<VideoFileContainerProbe | null>;
```

```ts
const probe = await probeVideoFileContainer({ kind: 'fs', path: '/tmp/clip.webm' });
// probe ≈ { inputFormatName: 'matroska,webm', codecName: 'vp9', codedWidth: 16, codedHeight: 16 }
```

Content sniff only (extension is not used as a demuxer hint). Compare `inputFormatName` / `codecName` to a filename extension **in your app** — the SDK does not. Unsupported codecs such as VP9 still return metadata here; `createOfflineVideoBufferFromFile` would reject `VIDEO_CODEC_UNSUPPORTED`.

| Field | Meaning |
| --- | --- |
| `inputFormatName` | FFmpeg `iformat->name`, e.g. `mov,mp4,…` / `matroska,webm`. |
| `codecName` | Primary **video** codec short name (`h264`, `hevc`, `vp9`, …). |
| `codedWidth` / `codedHeight` | Coded frame size from the video stream. |
| `audioCodecName` | Present when a primary audio track exists (`aac`, `opus`, …). |

A string path is rejected (`VIDEO_INVALID_ARGUMENT`). Same `FileSource` resolver as open (including `fileio_nofd` copy + unpin when the call returns).

#### `createOfflineVideoBufferFromFile(source)`

```ts
function createOfflineVideoBufferFromFile(
  source: FileSource
): Promise<OfflineVideoBufferRef>;
```

```ts
const video = await createOfflineVideoBufferFromFile({
  kind: 'fs',
  path: '/tmp/clip.mp4',
});
// video ≈ {
//   bufferId: 'vid_off_8f3a…',
//   info: {
//     bufferId: 'vid_off_8f3a…',
//     kind: 'offlineVideoBuffer',
//     state: 'immutable',
//     frameCount: 300,
//     seekableStartUs: 0,
//     seekableEndUs: 10_000_000,
//     audio: {
//       codec: 'aac',
//       decodable: true,
//       sampleRate: 48000,
//       channels: 2,
//       startMs: 0,
//       durationMs: 10000,
//     },
//   },
// }
```

`source` is a `FileSource` (see [fileio.md](fileio.md)). Same resolver as audio/image/pdf. Needs FFmpeg. Does not decode pixels at create time.

| Kind | How the file is opened |
| --- | --- |
| `fs` / `app` (`cache`, `files`, …) / `pad` / iOS `appBundle` / iOS `securityScoped` | Direct path. |
| Android `app` + `apkAsset` | APK zip entry has no fd. Copied to `<cache>/fileio_apkasset/…` on first open; later opens are a cache hit. |
| Android `contentUri` with ParcelFileDescriptor | Opened via `/proc/self/fd/N` (seekable). |
| Android `contentUri` stream (no PFD) | Copied to `<cache>/fileio_nofd/<sha256>` on first open; later opens of the same URI are a cache hit. Unpinned copies follow the [fileio_nofd policy](fileio.md#configurefileiooptions) (default 512 MiB / 24 h). |

A string path is rejected (`VIDEO_INVALID_ARGUMENT`).

**Returns** (`OfflineVideoBufferRef`)

| Field | Meaning |
| --- | --- |
| `bufferId` | Branded id (`vid_off_…`). Pass the **ref** into other APIs. |
| `info` | Creation snapshot (`kind`, `frameCount`, seekable window, `audio`). Same shape as `getVideoBufferInfo`. |

#### `createOfflineImageBufferFromVideo(video, options?)`

```ts
function createOfflineImageBufferFromVideo(
  video: OfflineVideoBufferIdSource,
  options?: CreateOfflineImageFromVideoOptions
): Promise<{ imageBufferId: string; frameCount: number }>;
```

```ts
const images = await createOfflineImageBufferFromVideo(video, { sampling: 'fps', fps: 2, maxSide: 1280 });
// images ≈ { imageBufferId: 'img_off_1c2d…', frameCount: 20 }
```

Copies sampled frames into an [offline ImageBuffer](imagebuffer-offline.md). Pass `images.imageBufferId` to OCR / `getOfflineImageBufferFrameInfo`. Each frame may include `source: { videoBufferId, ptsUs, frameIndex }` — OCR fills `TextSpatialSpan.ptsMs` from that PTS. Accepts **offline** and **finished live**. Recording live → `VIDEO_BUFFER_INVALID_STATE`.

Release with `releaseOfflineImageBuffer` from `react-native-sherpa-onnx/imagebuffer`.

**`options.sampling`** (`CreateOfflineImageFromVideoOptions`)

| Value | Extra fields | Frames taken |
| --- | --- | --- |
| `'all'` (default) | — | Every decoded frame. |
| `'keyframes'` | — | Keyframes only. |
| `'fps'` | `fps` (required) | ~`fps` frames per second of **video time**. |
| `'uniform'` | `uniformCount` (required) | `uniformCount` frames spread across the duration. |
| `'times'` | `timesUs` (required) | Nearest frame at each PTS (µs). |

**`options`** (`CreateOfflineImageFromVideoOptions`)

| Field | Default | Meaning |
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
// file ≈ { kind: 'fs', path: '/tmp/frame.jpg' }
```

Decodes the nearest frame at `ptsUs` and writes it via [fileio](fileio.md). Accepts **offline** and **finished live**. `ptsUs` outside the clip → `VIDEO_FRAME_OUT_OF_RANGE`.

**`options`** (`ExportVideoFrameOptions`)

| Field | Default | Meaning |
| --- | --- | --- |
| `format` | `'jpeg'` | `'jpeg'` \| `'png'` \| `'webp'`. WebP needs libwebp enabled ([imagebuffer-offline.md](imagebuffer-offline.md)). |
| `quality` | encoder default | JPEG/WebP quality. |
| `maxSide` | no cap | Longest-edge cap before encode. |

#### `exportVideo(video, output, format, options?)`

```ts
function exportVideo(
  video: OfflineVideoBufferIdSource,
  output: FileDestination,
  format: 'mp4' | 'mov' | 'mkv' | 'webm',
  options?: ExportVideoOptions
): Promise<ResolvedFileRef>;
```

```ts
const file = await exportVideo(video, { kind: 'fs', path: '/tmp/out.mp4' }, 'mp4');
// file ≈ { kind: 'fs', path: '/tmp/out.mp4' }
```

HW-transcodes the clip (decode NV12 → MediaCodec / VideoToolbox → FFmpeg mux). Accepts **offline** and **finished live**. Recording live → `VIDEO_BUFFER_INVALID_STATE`. The buffer is not mutated. Always transcodes (no packet-copy remux). FFmpeg compiled out → `VIDEO_FFMPEG_DISABLED` (mux only; encode stays HW).

**`format` / `options`** (`ExportVideoOptions`)

| Field | Default | Meaning |
| --- | --- | --- |
| `format` | required | `'mp4'` \| `'mov'` \| `'mkv'` \| `'webm'`. WebM here is H.264/HEVC in a Matroska/WebM shell (not VP9). |
| `codec` | `'h264'` | `'h264'` \| `'hevc'`. |
| `bitrate` | `2_000_000` | Video encoder bitrate (bits/s). |
| `fromUs` / `toUs` | seekable start / end | Inclusive range on the video timeline (µs). `toUs` must be `> fromUs` when both are set. |
| `maxSide` | no cap (`0`) | Longest-edge cap before encode. |
| `onProgress` | — | `{ percent, encodedUs }`. |
| `signal` | — | Abort → `VIDEO_CANCELLED`. |

Audio follows the container: **mp4/mov → AAC**, **mkv/webm → Opus**. No audio track → video-only file. Missing HW encoder → `VIDEO_ENCODER_UNAVAILABLE` / `VIDEO_CODEC_UNSUPPORTED`. CPU decoder busy → `VIDEO_DECODER_UNAVAILABLE`.

#### `createOfflineAudioBufferFromVideo(video, options?)`

```ts
function createOfflineAudioBufferFromVideo(
  video: OfflineVideoBufferIdSource,
  options?: CreateOfflineAudioFromVideoOptions
): Promise<VideoAudioExtractResult>;
```

```ts
const { audio, mediaStartMs } = await createOfflineAudioBufferFromVideo(video, { targetSampleRateHz: 16000 });
// ≈ {
//   audio: {
//     bufferId: 'off_9ab0…',
//     info: {
//       bufferId: 'off_9ab0…',
//       kind: 'offlinePcmBuffer',
//       state: 'immutable',
//       sampleRate: 16000,
//       channelCount: 1,
//       numSamples: 160000,
//       durationMs: 10000,
//       storageKind: 'ram',
//     },
//   },
//   mediaStartMs: 0,
//   sourceCodec: 'aac',
//   sourceSampleRate: 48000,
//   sourceChannels: 2,
// }
```

Decodes the container audio track into an [offline AudioBuffer](audiobuffer-offline.md). Needs FFmpeg. Accepts **offline** and **finished live**. Recording live → `VIDEO_BUFFER_INVALID_STATE` (use `createLiveAudioBufferFromLiveVideo`).

No audio track → `VIDEO_NO_AUDIO_TRACK`. `info.audio.decodable === false` → `VIDEO_AUDIO_CODEC_UNSUPPORTED`.

**`options`** (`CreateOfflineAudioFromVideoOptions`)

| Field | Default | Meaning |
| --- | --- | --- |
| `targetSampleRateHz` omitted | `16000` | Resample to 16 kHz (STT default). |
| `targetSampleRateHz: 0` | — | Keep the source rate. |
| `targetSampleRateHz > 0` | — | Exact output rate. |
| `rangeMs` | full track | `{ startMs, endMs }` on the **video** timeline (`endMs > startMs`). |
| `onProgress` | — | `{ percent, decodedMs }`. |
| `signal` | — | Abort → `VIDEO_CANCELLED`. |

**Returns** (`VideoAudioExtractResult`)

| Field | Meaning |
| --- | --- |
| `audio` | Offline AudioBuffer ref to pass into STT / enhancement. Release with `releasePipelineAudioBuffer`. |
| `mediaStartMs` | Video-timeline time of PCM sample 0 (edit list, late audio, or `rangeMs.startMs`). |
| `sourceCodec` / `sourceSampleRate` / `sourceChannels` | Container track before resample. |

Preview playback of the same track is a separate API (`react-native-sherpa-onnx/videopreview`); it does not play through this AudioBuffer.

---

## Formats

FFmpeg demuxes the container. Pixels use the shared codec layer ([codecs.md](./codecs.md)): platform HW, then platform SW, then opt-in bundled FFmpeg (`ffmpeg-vsw`). Default policy `preferHardware`. Strict `hardware` fails when no HW session is usable. No FFmpeg → `VIDEO_FFMPEG_DISABLED` on open. Sniff is by container, not extension (`probeVideoFileContainer`).

| | Import | Export (`exportVideo`) |
| --- | --- | --- |
| **Containers** | MP4 / MOV / M4V / 3GP (`mov`); MKV / WebM (`matroska`) | `'mp4'` \| `'mov'` \| `'mkv'` \| `'webm'` |
| **Video codecs** | **H.264**, **HEVC** | `'h264'` (default) \| `'hevc'` (MediaCodec / VideoToolbox) |
| **Audio** | AAC, MP3, Opus, Vorbis, FLAC, pcm_s16le, pcm_f32le (`decodable: true`) | mp4/mov → AAC; mkv/webm → Opus. No track → video-only |
| **Else** | Other video codecs → `VIDEO_CODEC_UNSUPPORTED`. WebM+VP9 still rejected. No video stream → `VIDEO_NO_VIDEO_TRACK`; other containers → `VIDEO_CONTAINER_UNSUPPORTED` | VP8/VP9/AV1 encode is out of scope. WebM export is H.264/HEVC in a Matroska/WebM shell, not VP9 WebM. `'mov'` needs the `mov` muxer in the FFmpeg prebuilt (pin ≥ 8.1.3-1); missing muxer → `VIDEO_ENCODE_FAILED`. |

| Audio in container | |
| --- | --- |
| AAC, MP3, Opus, Vorbis, FLAC, pcm_s16le, pcm_f32le | `decodable: true` — extract / preview |
| AC-3 and anything else | extract → `VIDEO_AUDIO_CODEC_UNSUPPORTED`; preview continues muted (`unsupportedCodec`) |

Extract → `OfflineAudioBuffer` float32. Image bridge / `exportVideoFrame`: RGB stills `jpeg` \| `png` \| `webp` (WebP = libwebp opt-in). Clip export: `exportVideo` (HW encode + FFmpeg mux). Internal decode planes: NV12 / Gray8 / RGB24.

Out of scope: AVI, MPEG-TS, FLV, AV1 / VP8 / VP9 decode or encode, bundled SW H.264/HEVC **encoders**, packet-copy remux. Bundled SW **decode** is the opt-in `ffmpeg-vsw` variant.

## JS Events

Offline video buffers have **no subscribe API**. Opening a file (`createOfflineVideoBufferFromFile`), sampling frames (`createOfflineImageBufferFromVideo` / `exportVideoFrame`), and clip export (`exportVideo`) are one-shot native calls.

Create-time callbacks exist on **audio extract** and **clip export**:

| Callback / control | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onProgress` | `{ percent, decodedMs }` | during `createOfflineAudioBufferFromVideo` | Native channel `decodeProgress`, filtered by `operationId`. `decodedMs` is audio time decoded, not video PTS. |
| `onProgress` | `{ percent, encodedUs }` | during `exportVideo` | Same native channel `decodeProgress`. `encodedUs` is last encoded video PTS. |
| `signal` | `AbortSignal` | caller aborts | rejects with `VIDEO_CANCELLED` |

```ts
const controller = new AbortController();
const { audio } = await createOfflineAudioBufferFromVideo(video, {
  targetSampleRateHz: 16000,
  onProgress: (e) => console.log(e.percent, e.decodedMs),
  signal: controller.signal,
});
// controller.abort();
```

Live ingest / ring updates: [videobuffer-streaming.md — JS Events](videobuffer-streaming.md#js-events). Preview playback events: [videopreview.md](videopreview.md) (`player.addListener`).

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
| `ExportVideoOptions` | `codec`, `bitrate`, `fromUs`, `toUs`, `maxSide`, `onProgress`, `signal`. |
| `CreateOfflineAudioFromVideoOptions` | `targetSampleRateHz`, `rangeMs`, `onProgress`, `signal`. |
| `VideoAudioExtractResult` | `{ audio, mediaStartMs, sourceCodec, sourceSampleRate, sourceChannels }`. |
| `ConfigureVideoBufferOptions` | Deprecated empty options. Use `configureCodecs`. |
| `VideoFileDurationProbe` | `{ durationUs, isExact }` from `probeVideoFileDuration`. |
| `VideoFileContainerProbe` | `{ inputFormatName, codecName, codedWidth, codedHeight, audioCodecName? }`. |

---

## Error codes

Thrown / rejected as `VIDEO_…` (`Error` message `VIDEO_…: …`, native reject code the same).

| Code | Typical cause |
| --- | --- |
| `VIDEO_INVALID_ARGUMENT` | Malformed id, `rangeMs`, sampling fields. |
| `VIDEO_BUFFER_NOT_FOUND` | Released or unknown id. |
| `VIDEO_BUFFER_KIND_MISMATCH` | Live recording passed where an offline/finished clip is required. |
| `VIDEO_BUFFER_INVALID_STATE` | Offline extract/export on a **recording** live buffer. |
| `VIDEO_FFMPEG_DISABLED` | File open, probe, audio extract, or `exportVideo` mux with FFmpeg compiled out. |
| `VIDEO_DURATION_UNKNOWN` | Probe could not read or estimate duration. JS wrappers return `null`. |
| `VIDEO_CONTAINER_UNSUPPORTED` | Container not in the v1 set. |
| `VIDEO_NO_VIDEO_TRACK` | Audio-only file. |
| `VIDEO_NO_AUDIO_TRACK` | Extract audio but the clip has no audio. |
| `VIDEO_CODEC_UNSUPPORTED` | Video codec not H.264/HEVC, or no usable decoder/encoder for the resolved policy. |
| `VIDEO_ENCODER_UNAVAILABLE` | No encoder session for the requested `codec` / policy (pool-full or caps). |
| `VIDEO_ENCODE_FAILED` | Encode or mux error during `exportVideo`. |
| `VIDEO_AUDIO_CODEC_UNSUPPORTED` | Audio codec not in the SDK FFmpeg build. |
| `VIDEO_DECODER_UNAVAILABLE` | No decoder session for the resolved policy (pool-full, missing HW, or SW disabled). |
| `VIDEO_SW_DECODER_DISABLED` | Bundled SW decode requested but `ffmpeg-vsw` is not present / `avcodec_find_decoder` failed. |
| `VIDEO_DECODE_FAILED` | Decode error on a frame. |
| `VIDEO_AUDIO_DECODE_FAILED` | Audio extract produced no PCM in range / decode error. |
| `VIDEO_FRAME_OUT_OF_RANGE` | `ptsUs` / `timesUs` outside the clip. |
| `VIDEO_FILE_CORRUPT` | Demux/index failed. |
| `VIDEO_CANCELLED` | `signal` aborted audio extract or `exportVideo`. |
| `VIDEO_MEMORY_BUDGET_EXCEEDED` | Decode/RGB copy exceeded the process budget. |

Preview-only codes (`VIDEO_PREVIEW_…`) are documented in [videopreview.md](videopreview.md).

---

## See also

- [Pipeline video buffers — live / streaming](videobuffer-streaming.md)
- [Video preview](videopreview.md)
- [Pipeline image buffers — offline](imagebuffer-offline.md) (`source.ptsUs` on sampled frames)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [OCR — offline](ocr-offline.md)
- [fileio.md](fileio.md) (`FileSource` / `FileDestination` / `ResolvedFileRef`)
- [Disabling FFmpeg](disable-ffmpeg.md)

---

<details>
<summary>Use case examples</summary>

**OCR a clip at 2 fps, keep timestamps**

```ts
const video = await createOfflineVideoBufferFromFile({
  kind: 'fs',
  path: '/tmp/clip.mp4',
});
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
