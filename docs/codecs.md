# Codec policies

Shared HW/SW de/encoding for VideoBuffer and ImageBuffer. Every use (`video.decode`, `video.display`, `video.encode`, `image.decode`, `image.encode`) defaults to **`preferHardware`**. There is no `preferSoftware`. Encode-HW and decode-HW are independent: a device can HW-decode VP9 and still SW-encode.

## Policies

| Policy | Behavior |
| --- | --- |
| `hardware` | Only hardware / OS codecs. Deterministic error if none is usable. |
| `software` | Platform SW first, then bundled. Deterministic error if libs are missing. |
| `preferHardware` | Hardware, then platform SW, then bundled. Fallback is always logged. |

## Cascade

Resolved once per session open and logged under `SherpaOnnxCodec`:

`operation option > buffer option > configureCodecs() global > SDK default`

```ts
import {
  configureCodecs,
  getCodecInfo,
  subscribeCodecEvents,
} from 'react-native-sherpa-onnx/codec';

await configureCodecs({
  video: { decode: 'preferHardware', encode: 'hardware' },
  image: { decode: 'preferHardware', encode: 'preferHardware' },
  budgets: { hwVideoEncode: 1 }, // 1..4, omit = auto from RAM class
});

const info = await getCodecInfo();
const unsub = subscribeCodecEvents((e) => {
  if (e.type === 'slotFreed') {
    // retry a failed export / decode
  }
});
```

Per-call `decodePolicy` / `encodePolicy` on `createOfflineVideoBufferFromFile`, `createEmptyLiveVideoBuffer`, `exportVideo`, `exportOfflineImageBufferFrame`, `exportVideoFrame`, `createOfflineImageBufferFromVideo`, `createVideoPreviewPlayer`, and image create APIs. Slot vs decoded-frame RAM: [videobuffer-offline.md — Budgets](videobuffer-offline.md#budgets).

## Video decode

Opening a file does not decode pixels. CPU decode (`createOfflineImageBufferFromVideo`, `exportVideoFrame`, `exportVideo`) uses `hwVideoDecode`. Preview uses `hwVideoDisplay`. Same cascade for H.264, HEVC, and VP9. Strict `hardware` never falls back to FFmpeg.

| Codec | Android | iOS VT | Bundled SW |
| --- | --- | --- | --- |
| H.264 | MediaCodec `video/avc` (HW, then platform SW) | HW, then SW | `ffmpeg.h264` in **`ffmpeg-vsw` only** |
| HEVC | MediaCodec `video/hevc` (HW, then platform SW) | HW, then SW | `ffmpeg.hevc` in **`ffmpeg-vsw` only** |
| VP9 | MediaCodec `video/x-vnd.on2.vp9` (HW, then platform SW) | — | `ffmpeg.vp9` in **default** FFmpeg (native `vp9`) |

iOS has no VideoToolbox VP9 — decode and display go through `ffmpeg.vp9` only.

## Video encode

`exportVideo` transcodes (no packet-copy remux). Android uses MediaCodec when the device lists an encoder; otherwise bundled `ffmpeg.vp9` (`libvpx-vp9`) when that encoder is in the FFmpeg pin. iOS VideoToolbox covers H.264/HEVC only.

Default `codec: 'h264'` still writes H.264 inside `webm`/`mkv` (Matroska shell). Real VP9 is `codec: 'vp9'` only.

| `format` | `h264` / `hevc` | `vp9` |
| --- | --- | --- |
| `mp4` / `mov` | yes | reject (`VIDEO_INVALID_ARGUMENT`) |
| `mkv` / `webm` | H.264/HEVC in that shell | real VP9 (`webm` muxer only for `webm`+`vp9`) |

## Image decode

Sniff is by magic bytes, not extension. GIF/WebP: first frame only. EXIF and format notes: [imagebuffer-offline.md](imagebuffer-offline.md#formats).

| Format | Android | iOS | Bundled SW |
| --- | --- | --- | --- |
| JPEG / PNG / BMP / GIF | stb | stb | stb (always) |
| WebP | opt-in libwebp | opt-in libwebp | libwebp; off → `ERR_IMAGE_WEBP_DISABLED` |
| HEIC / HEIF | API 30+ `AImageDecoder`; 28–29 Kotlin `ImageDecoder`; older `os-too-old` | ImageIO | — (`software` → `ERR_IMAGE_SW_DECODER_UNAVAILABLE`) |

## Image encode

JPEG/PNG on Android 24–29 and `software` use stb. `hardware` on API 24–29 → `ERR_IMAGE_HW_ENCODER_UNAVAILABLE`.

| Format | Android | iOS | Bundled SW |
| --- | --- | --- | --- |
| JPEG / PNG | API 30+ `AndroidBitmap_compress` | ImageIO | stb |
| WebP | API 30+ platform if libwebp is off | — | opt-in libwebp (`preferHardware` / `software`) |
| HEIC | — | ImageIO only | — |

## Bundled SW video (`ffmpeg-vsw`)

Default FFmpeg already has audio, native VP9 decode, and `libvpx-vp9` encode (when the pin includes libvpx). H.264/HEVC SW **decode** stays in the opt-in `ffmpeg-vsw` variant so default install size and patent surface stay unchanged. H.264/HEVC **patents** are separate from LGPL-2.1.

The example app opts in. VoiceLab and other consumers keep it **off**. Availability is `avcodec_find_decoder` at runtime; missing → `VIDEO_SW_DECODER_DISABLED`.

| Flag | Artifact |
| --- | --- |
| Android `sherpaOnnxEnableVideoSwDecoders=true` | Maven `com.xdcobra.sherpa:ffmpeg-vsw` or `ffmpeg-vsw-android.zip` |
| iOS `SHERPA_ONNX_ENABLE_VIDEO_SW_DECODERS=1` | `ffmpeg-vsw-ios-framework.zip` |

Publish with the **FFmpeg video-SW** GitHub Actions (`ANDROID_VSW_RELEASE_TAG` / `IOS_VSW_RELEASE_TAG`).

## Errors

| Code | When |
| --- | --- |
| `VIDEO_DECODER_UNAVAILABLE` / `VIDEO_ENCODER_UNAVAILABLE` | No usable codec for the policy (`not-present`, `os-too-old`, `unsupported-stream`, `configure-failed`, …) |
| `VIDEO_DECODER_BUSY` / `VIDEO_ENCODER_BUSY` / `VIDEO_PREVIEW_DECODER_BUSY` | Slot full |
| `VIDEO_SW_DECODER_DISABLED` / `VIDEO_SW_ENCODER_DISABLED` | Bundled SW requested but not in this FFmpeg |
| `ERR_IMAGE_*_DECODER_UNAVAILABLE` / `ERR_IMAGE_*_ENCODER_UNAVAILABLE` | Image policy cannot be satisfied |
| `CODEC_INVALID_ARGUMENT` | Bad policy or budget outside 1–4 |
