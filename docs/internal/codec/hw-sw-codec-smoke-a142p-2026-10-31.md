# Codec smoke S0–S5 — 2026-10-31

Example `ffmpeg-vsw` **on** (`sherpaOnnxEnableVideoSwDecoders` / `SHERPA_ONNX_ENABLE_VIDEO_SW_DECODERS`). Consumer / VoiceLab default stays **off**.

| Platform | Device | JSON | Score |
| --- | --- | --- | --- |
| Android | Nothing A142P (`PacmanPro`, API 36) | [evidence/a142p-2026-10-31-codec-smoke-results.json](./evidence/a142p-2026-10-31-codec-smoke-results.json) | **15 pass / 0 fail / 5 skip** |
| iOS | iPhone 17 Pro Simulator / 26.3.1 | [evidence/iphone17pro-2026-10-31-codec-smoke-results.json](./evidence/iphone17pro-2026-10-31-codec-smoke-results.json) | **11 pass / 0 fail / 9 skip** |

Catalog dump (pre-smoke): [evidence/a142p-video-codecs-2026-10-31.txt](./evidence/a142p-video-codecs-2026-10-31.txt).

## What the suite showed

- **Catalog.** Android: `ffmpeg.h264` / `ffmpeg.hevc` available; MTK HW AVC/HEVC; platform SW (`c2.android.*`, `OMX.google.*`) with ~1080p cap. iOS: `vt.hw` decode `available=false` / `not-present` (`VTIsHardwareDecodeSupported`); `vt.sw` + encode `vt.hw` available; `ffmpeg.*` catalog fallback.
- **S1.1.** `hwVideoEncode=1`, two parallel HW encodes → one file, one `VIDEO_ENCODER_UNAVAILABLE` / `pool-full`. Decode on iOS Simulator is `preferHardware` (no VT HW decode).
- **S1.2 / S3.3.** `preferHardware` → iOS `vt.sw` after `vt.hw: not-present` and `fake: configure-failed`. Android HW decode `OMX.MTK.VIDEO.DECODER.AVC`.
- **S2.1.** 1080p H.264 software: `OMX.google.h264.decoder`.
- **S2.2 / S4.1.** 4K HEVC software: Android `ffmpeg.hevc`; iOS `vt.sw` (platform SW covers 4K; ffmpeg not selected first).
- **S2.4 / S2.5.** SW encode 720p succeeds; 1080p rejected (`unsupported-stream` / D7).
- **S2.6.** Abort mid-export → `VIDEO_CANCELLED`; recreate succeeds.
- **S2.7.** A142P default and `hardware` both `OMX.MTK.VIDEO.DECODER.AVC` (device has HW).
- **S3.1.** iOS software decode `vt.sw`.
- **S4.2.** Skip while example vsw is on (off-flag case).
- **S5.** JPEG/HEIC/`maxSide` + EXIF-6 upright (192×256). iOS stamps `ImageIO`. Android pixels/size correct; frame JSON `decoder` unset (EnsureFrame does not stamp provider; native select is `AImageDecoder`).

## Decisions

1. **S0–S5 closed** on A142P and iOS Simulator. No further smoke fixes for these cases.
2. **Default policy** stays `preferHardware`. Mid-stream SW fallback stays PreferHardware-only.
3. **`ffmpeg-vsw`:** example on; VoiceLab / consumers off (H.264/HEVC patents). S4.2 skip while the example flag is on is correct.
4. **Cascade (D4) is platform-correct:** iOS 4K uses `vt.sw`; Android 4K uses ffmpeg because platform SW HEVC is 1080p-capped.
5. **`vt.hw` decode catalog** stays gated by `VTIsHardwareDecodeSupported`. Encode stays advertised.
6. **Lookahead** (up to 8 packets + EOS) stays. No ByteBuffer fallback.
7. **`fake` HW providers** still register `available=true` and configure-fail first. Optional later: do not advertise on device. Not a smoke fail.
8. **Android S5 `decoder=none`:** telemetry gap only. Optional later: stamp `decoderProvider` on ensure.
9. **Not run:** benches B1–B9; real iPhone (VT HW decode / reclaim); S4.2 with vsw off; S5.2/S5.3 on API 26/28.
10. Phase 6 optional / skip. Phase 7 skip. Example Codec-smoke screen removed after this run. **No commit** unless asked.
