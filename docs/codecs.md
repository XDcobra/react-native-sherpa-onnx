# Codec policies

Shared HW/SW de/encoding for VideoBuffer and ImageBuffer.

## Default

Every use (`video.decode`, `video.display`, `video.encode`, `image.decode`) defaults to **`preferHardware`**.

| Policy | Behavior |
| --- | --- |
| `hardware` | Only hardware / OS codecs. Deterministic error if none is usable. |
| `software` | Only software (platform SW first, then bundled). Deterministic error if libs are missing. |
| `preferHardware` | Hardware first, then software. Fallback is always reported. |

There is no `preferSoftware`.

## Cascade

`operation option > buffer option > configureCodecs() global > SDK default`

Resolved once per session open and logged under tag `SherpaOnnxCodec`.

```ts
import {
  configureCodecs,
  getCodecInfo,
  subscribeCodecEvents,
} from 'react-native-sherpa-onnx/codec';

await configureCodecs({
  video: { decode: 'preferHardware', encode: 'hardware' },
  image: { decode: 'preferHardware' },
  budgets: { hwVideoEncode: 1 }, // 1..4, omit = auto from RAM class
});

const info = await getCodecInfo();
const unsub = subscribeCodecEvents((e) => {
  if (e.type === 'slotFreed') {
    // retry a failed export / decode
  }
});
```

Per-call overrides: `decodePolicy` / `encodePolicy` on `createOfflineVideoBufferFromFile`, `createEmptyLiveVideoBuffer`, `exportVideo`, `createOfflineImageBufferFromVideo`, `createVideoPreviewPlayer`, and image create APIs.

## Errors

New codes: `VIDEO_SW_DECODER_DISABLED`, `VIDEO_SW_ENCODER_DISABLED`, `ERR_IMAGE_SW_DECODER_UNAVAILABLE`, `ERR_IMAGE_HW_DECODER_UNAVAILABLE`, `CODEC_INVALID_ARGUMENT`.

Existing `VIDEO_DECODER_UNAVAILABLE` / `VIDEO_ENCODER_UNAVAILABLE` / `VIDEO_PREVIEW_DECODER_BUSY` now include `codecReason` (`pool-full`, `not-present`, `os-too-old`, `unsupported-stream`, `configure-failed`, …).

## Bundled SW video (`ffmpeg-vsw`)

Default FFmpeg prebuilts stay audio-only. The example app sets the flags **off** so smoke S4.2 hits `VIDEO_SW_DECODER_DISABLED`.

Publish the variant with the **FFmpeg video-SW** GitHub Actions (tag files `ANDROID_VSW_RELEASE_TAG` / `IOS_VSW_RELEASE_TAG`), then opt in:

- Android Gradle: `sherpaOnnxEnableVideoSwDecoders=true` → Maven `com.xdcobra.sherpa:ffmpeg-vsw` or `ffmpeg-vsw-android.zip`
- iOS Pod: `SHERPA_ONNX_ENABLE_VIDEO_SW_DECODERS=1` → `ffmpeg-vsw-ios-framework.zip`

Availability is detected at runtime with `avcodec_find_decoder`. Missing decoders map to `VIDEO_SW_DECODER_DISABLED`.

H.264/HEVC **patents** are separate from the LGPL-2.1 license. The variant is off by default so the default install size and patent surface stay unchanged.

## Device smoke

The example app **Codec smoke** screen (`__DEV__`) lists S0–S5. Run on a device; host tests do not replace them. Filter Android with `adb logcat -s SherpaOnnxCodec SherpaOnnx`.
