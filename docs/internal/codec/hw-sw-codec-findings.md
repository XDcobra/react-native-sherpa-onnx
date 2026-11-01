# Shared HW/SW codec layer — research findings

**Date:** 2026-10-31  
**Base:** `feat/videobuffer-hw-slot-caps` from `origin/refactor/refactor-before-release-1-0` @ `d679d5c7` (contains VideoBuffer PR #151 incl. the Matroska / ImageReader fixes, and ImageBuffer perf PR #152).  
**Plan:** [hw-sw-codec-implementation-plan.md](./hw-sw-codec-implementation-plan.md)  
**Raw device evidence:** [evidence/a142p-video-codecs-2026-10-31.txt](./evidence/a142p-video-codecs-2026-10-31.txt)

Question: should the SDK offer software (SW) de/encoders next to hardware (HW), selectable per call as `hardware` / `software` / `preferHardware` (HW, then SW on `VIDEO_DECODER_UNAVAILABLE` / `VIDEO_PREVIEW_DECODER_BUSY`)? And should that live in one shared C++ layer that ImageBuffer and VideoBuffer use now, and the Kotlin buffers use once they are ported?

Short answer: yes, and most of the SW tier already ships with the OS. One shared layer is the right shape. It should own catalog, caps, slots, policy, and decision reporting. Codec backends stay per domain.

---

## 1. Key findings

1. **Android ships SW video codecs for free.** `c2.android.avc/hevc.decoder` and `c2.android.avc.encoder` exist on every Android 10+ device (Codec2, Mainline `media.swcodec`), with `OMX.google.*` on 7–9. They use the same NDK `AMediaCodec` API we already drive. We exclude them on purpose today (`VideoCodecCatalog.kt`). Enabling them adds no binary size, no new license, and no patent surface for us, because the OS vendor licenses platform codecs.
2. **But Android platform SW has hard ceilings.** On the A142P: SW AVC/HEVC decode tops out at **1920×1088**. The SW HEVC encoder tops out at **512×512**, which makes it useless for export. The SW AVC encoder advertises Level 3 limits (1620 macroblocks per frame, about 720×576). 4K phone footage cannot be decoded through platform SW at all.
3. **iOS can force or forbid HW since iOS 17.** `kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder` / `EnableHardwareAcceleratedVideoDecoder` (iOS 17.0) and the encoder equivalents (iOS 17.4) are public. `kVT…PropertyKey_UsingHardwareAccelerated…` reports what was picked. That is a platform SW tier on iOS too.
4. **Our iOS path is not strictly HW today.** `VideoToolboxDecoder` only checks `VTIsHardwareDecodeSupported` and then creates a session without `Require…`. The header says HW can be unavailable because "the hardware decode resources on the machine are busy", and without `Require…` VT may pick software. So iOS already behaves like an unreported `preferHardware`. Android is strictly HW (create by HW name).
5. **No benchmark ever measured video decode or encode.** The VideoBuffer benches ranked buffer layout, libyuv, slab, index, and HW seek policy. HW vs SW decoder cost is unmeasured. The best data we have is the OEM `measured-frame-rate` table in the device dump (§3.1).
6. **ImageBuffer benches say no new SW library is worth it, but the platform path is under-measured.** stb + scalar beat libjpeg-turbo, libyuv RGB24 scale, and Wuffs on 24MP. Android `ImageDecoder` was 10.1× faster than turbo. That number covers decode only, without the RGB8 copy or `setTargetSize`, and it ran through Kotlin. The iOS ImageIO 0.80× is simulator-only, full-size only. The scaled platform paths (`AImageDecoder_setTargetSize`, `CGImageSourceCreateThumbnailAtIndex`) were never benched. They matter because the default `maxSide` 4096 downscales every 24MP photo.
7. **Missing shared SW libraries.** For images: none. For video: only a bundled H.264/HEVC SW decoder for the cases platform SW cannot cover (iOS < 17, > 1080p on Android, HW busy plus platform SW missing). The clean source is the **FFmpeg we already ship** (`h264`, `hevc` decoders, LGPL-2.1), as an **opt-in build variant**, because bundling them adds patent surface that platform codecs do not. There is no acceptable bundled H.264/HEVC SW **encoder** (x264/x265 are GPL; openh264 has the same patent caveat and weak quality). libyuv (already shipped) is the shared converter for every SW output (I420→NV12, RGBA→RGB24).
8. **The existing seams are a good start but too narrow.** We already have `RegisterDecoderFactory` / `RegisterEncoderFactory` (one global factory each), `ImageDecoder::SetPlatformHeicDecoder` (one hook), and `DecoderPool` with `Cpu` / `Display` classes. A shared layer generalizes these into a provider catalog plus resource-class arbiter instead of adding a third ad-hoc hook.

---

## 2. Where de/encoding happens today

| Buffer (layer) | Operation | Backend | Tier | Pool / cap | Exclusion mechanism |
| --- | --- | --- | --- | --- | --- |
| VideoBuffer (C++) | CPU frames (OCR, `getFrame`, iterate, image bridge, export input) | Android `AMediaCodecDecoder` + `AImageReader`; iOS `VideoToolboxDecoder` | HW (iOS: implicitly may be SW) | `DecoderPool` class `Cpu`, default 1, `Acquire` waits 5 s | none — no HW → `VIDEO_DECODER_UNAVAILABLE` |
| VideoPreview (C++) | display | Android `MediaCodecSurfaceRenderer` (codec bound to Surface); iOS `SampleBufferVideoRenderer` (compressed samples into `AVSampleBufferDisplayLayer`, system decodes) | HW (iOS: system choice) | `DecoderPool` class `Display`, default 1, fail-fast | none — `VIDEO_PREVIEW_DECODER_BUSY` |
| VideoBuffer (C++) | `exportVideo` encode | `AMediaCodecEncoder` / `VideoToolboxEncoder` | HW | **no pool** | none — `VIDEO_ENCODER_UNAVAILABLE` |
| VideoBuffer (C++) | demux / mux / audio track | FFmpeg avformat + audio decoders | SW | none | `sherpaOnnxDisableFfmpeg` → `VIDEO_FFMPEG_DISABLED` |
| ImageBuffer (C++) | JPEG/PNG/BMP/GIF decode | stb_image | SW | none (serial create, lazy ensure) | always on |
| ImageBuffer (C++) | WebP decode/encode | libwebp | SW | none | opt-in `sherpaOnnxEnableLibwebp` → `ERR_IMAGE_WEBP_DISABLED` |
| ImageBuffer (C++ + platform) | HEIC decode | Android Kotlin `ImageDecoder` (API 28+, per-pixel Kotlin loop + JNI copy); iOS ImageIO full decode + draw | platform | none | API < 28 → decode fails |
| ImageBuffer (C++) | JPEG/PNG export | stb_image_write | SW | none | always on |
| OfflineAudioBuffer (Kotlin) | audio decode/encode | FFmpeg (aac, mp3, opus, vorbis, flac, pcm; libshine, libopus, aac, alac, flac) | SW | none | `VIDEO_FFMPEG_DISABLED` analog per feature |
| Text / Segment buffers (Kotlin) | — | no codec | — | — | — |

Seams already in the code:

| Seam | Where | Limitation |
| --- | --- | --- |
| `RegisterDecoderFactory` / `GetDecoderFactory` | `video/decode/DecoderFactory.cpp` | one global factory, no tier, no codec/size awareness |
| `RegisterEncoderFactory` | `video/encode/EncoderFactory.cpp` | same |
| `AMediaCodecDecoder::SetGlobalHwDecoderName(codec, name)` | `platform/android/AMediaCodecDecoder.cpp`, fed by `nativeSetHwCodecs` | one name per codec, HW only, process-global |
| `VideoCodecCatalog.kt` | first HW codec per MIME | drops SW codecs, drops caps (size ranges, instances, perf) |
| `DecoderPool` classes `Cpu`/`Display` | `video/decode/DecoderPool.*` | video-only; factory called inside the pool; `Configure` failure happens later in `DecodeSession`, so pool-full and HW-failed are two separate failure points |
| `ImageDecoder::SetPlatformHeicDecoder` | `image/decode/ImageDecoder.*` | HEIC-only hook; no policy |
| Build flags | Gradle property → CMake `-D…` → `HAVE_*`; Podspec ENV → `GCC_PREPROCESSOR_DEFINITIONS` | consistent pattern to reuse for a SW video variant |

---

## 3. Platform options

### 3.1 Android video

**APIs.**

| API | Level | Use |
| --- | --- | --- |
| NDK `AMediaCodec_createCodecByName` | 21 | create HW **or** SW codec by name; same backend code |
| Java `MediaCodecList` / `MediaCodecInfo.isHardwareAccelerated` / `isSoftwareOnly` / `isVendor` | 29 (name heuristics below) | catalog source for minSdk 24 |
| `CodecCapabilities.getMaxSupportedInstances` | 23 | upper-bound hint only (MTK reports 15 decode / 10 encode) |
| `VideoCapabilities.isSizeSupported`, `areSizeAndRateSupported`, `getSupportedPerformancePoints` (29) | 21 / 29 | gate a stream against a provider before trying it |
| NDK `AMediaCodecStore_*`, `AMediaCodecInfo_getMediaCodecInfoType` (`SOFTWARE_ONLY` / `HARDWARE_ACCELERATED`), `…getMaxSupportedInstances`, `ACodecPerformancePoint_*` | **36** | same catalog in pure C++; usable only on Android 16+, so Kotlin stays the source below 36 |
| `AMEDIACODEC_ERROR_INSUFFICIENT_RESOURCE` (1100), `AMEDIACODEC_ERROR_RECLAIMED` (1101) | NDK | HW resource exhaustion at configure, and mid-stream reclaim by the resource manager (background app losing codecs to a foreground app) |

**Device facts, Nothing A142P (MT6886, Android 16).** Values are copied from `dumpsys media.player`; `measured-frame-rate` is the OEM-measured fps range.

| Codec | Tier | Max size | Max instances | measured fps 720p | measured fps 1080p | 4K |
| --- | --- | --- | --- | --- | --- | --- |
| `c2.mtk.avc.decoder` | HW | 4096×2176 | 15 | 186–409 | 113–248 | perf point 30 |
| `c2.android.avc.decoder` | SW | **1920×1088** | (not listed) | 91–201 | 47–104 | — |
| `c2.mtk.hevc.decoder` | HW | 4096×2176 | 15 | 315–693 | 95–209 | 35–76 |
| `c2.android.hevc.decoder` | SW | **1920×1088**, bitrate ≤ 5 Mbps | (not listed) | 39–85 | (not listed) | — |
| `c2.mtk.avc.encoder` | HW | 3840×2176 | 10 | 64–141 | 30–66 | perf point 30 |
| `c2.android.avc.encoder` | SW | 1808×1808, block-count ≤ 1620 (Level 3) | (not listed) | 21–46 | 13–29 | — |
| `c2.android.hevc.encoder` | SW | **512×512** | (not listed) | — | — | — |
| `c2.android.av1-dav1d.decoder`, `c2.android.vp9.decoder` | SW | 1920×1088 | — | — | — | — |

Reading this:

- SW AVC decode is roughly **0.4×** HW at 1080p but still real-time. SW HEVC at 720p is about **0.12×** HW.
- The SW AVC encoder's caps contradict themselves. It lists 1080p measured fps, but its block-count limit excludes 1080p. Caps are hints. `Configure` is the only truth, and a public SDK must pick one rule and log it (plan D7).
- HW claims 15 decoder instances. We know from the Mali ImageReader crash that the practical limit is lower. Keep `min(RAM class, instances, 4)` as planned.
- The device also has `c2.mtk.heif.decoder`. Platform HEIC decode can therefore use the same HEVC hardware block as VideoBuffer, outside our pool.
- SW codecs accept `YUV420Flexible`, `YUV420Planar`, and `YUV420SemiPlanar` (NV12) input, and can render to a Surface. The preview path can use them unchanged; only the codec name differs.
- Emulators expose `c2.android.*`. Allowing the SW tier fixes the "VideoBuffer frame APIs do nothing on an AVD" gap without an emulator-only special case.

### 3.2 iOS video

| Key / API | iOS | Effect |
| --- | --- | --- |
| `VTIsHardwareDecodeSupported(codec)` | 11 | capability only; the header says it "does not guarantee that hardware decode resources will be available at all times" |
| `kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder` | 17.0 | session create **fails** if HW is impossible (no HW, unsupported config, **busy**) → strict `hardware` |
| `kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder = false` | 17.0 | "hardware decode will never be used" → platform `software` |
| `kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder` | 17.0 | read what was picked → decision reporting |
| `kVTVideoEncoderSpecification_Require…` / `Enable…` / `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder` | **17.4** | same for encode |

Pod minimum follows RN (`min_ios_version_supported`, 15.1). On 15.1–16.x neither strict HW nor forced SW can be requested, and we cannot read which one VT picked. For those versions, `hardware` is best effort and must be documented that way. `software` there is only the bundled tier.

Preview: `AVSampleBufferDisplayLayer` decodes compressed samples itself, so we cannot choose the tier. A SW (or strict-HW) preview on iOS means decoding ourselves, then enqueueing `CVPixelBuffer`-backed sample buffers into the same layer. That is a new renderer, not a flag.

To verify on a real iPhone (cannot be decided from the simulator): VT SW decoders exist for H.264 and HEVC; HW sessions get invalidated in background (`kVTInvalidSessionErr`) while SW sessions keep running; what `UsingHardwareAccelerated…` reports today.

### 3.3 Bundled SW video libraries

The SDK is MIT. Apps ship commercially. Rule from [imagebuffer-perf-plan §8.1](../imagebuffer/performance/imagebuffer-perf-plan.md): permissive or the existing LGPL FFmpeg only, no GPL. The existing VideoBuffer plan records why we stayed demux-only: "Container demuxing has no codec-patent surface; decode/encode is the OS/OEM codec." Bundled H.264/HEVC breaks that property, so it must be opt-in. Not legal advice.

| Library | Role | License | Patent surface for app publishers | Fit |
| --- | --- | --- | --- | --- |
| FFmpeg `h264`, `hevc` decoders (+ parsers) | SW decode, both platforms | LGPL-2.1 (current build, no `--enable-gpl`) | yes (AVC / HEVC pools) | **yes, opt-in variant**. Same FFmpeg pin, same `AVCodecContext` code we already use for audio, frame threads, host-testable with system libav (Homebrew has `h264`/`hevc`/`vp9`/`libdav1d`) |
| dav1d | AV1 decode | BSD-2 | royalty-free (AOM) | later, with AV1 demux support |
| libvpx | VP8/VP9 de/encode | BSD-3 + WebM patents grant | royalty-free | later, the "real WebM" epic |
| openh264 | H.264 SW encode/decode | BSD-2 | yes; Cisco's royalty coverage applies only to Cisco's runtime-downloaded binary, which App Store rules exclude | weak; defer |
| x264, x265 | H.264/HEVC SW encode | GPL | — | **rejected** |
| kvazaar | HEVC SW encode | BSD-3 | yes, and slow | rejected |
| libde265 / libheif | HEVC / HEIC SW decode | LGPL-3 | yes | rejected (LGPL-3) |

Size today: Android arm64 `libavcodec.so` (audio-only) is **976 KB**. Adding `h264` + `hevc` must be measured (plan bench B5). A separate variant keeps the default install unchanged.

### 3.4 Images

| Path | Platform | Notes |
| --- | --- | --- |
| stb_image (JPEG/PNG/BMP/GIF), libwebp | portable C++ | today's default; fully host-testable |
| NDK `AImageDecoder` | Android **30+** | C API in `android/imagedecoder.h`: JPEG, PNG, GIF, WebP, BMP, ICO, WBMP, HEIF, DNG; decodes **into caller memory** (RGBA_8888) with `setTargetSize` (scaled decode), crop, `setDataSpace`. No JNI, no `Bitmap`, no Kotlin pixel loop. EXIF orientation handling not stated in the header → verify with an EXIF-6 fixture |
| Java `ImageDecoder` | Android 28–29 | existing HEIC path via JNI; keep only as the HEIC fallback below 30 |
| NDK `AndroidBitmap_compress` | Android 30 | JPEG / PNG / WebP encode from a pixel buffer; WebP export without libwebp |
| ImageIO `CGImageSourceCreateThumbnailAtIndex` (`…ThumbnailMaxPixelSize`, `…WithTransform`) | iOS | scaled decode + EXIF transform in one call; not benched yet; today's HEIC path does full decode + two draws instead |
| ImageIO `CGImageDestination` | iOS | JPEG / HEIC / PNG encode |
| libheif + libde265 | portable | rejected (LGPL-3 + HEVC patents); HEIC stays platform-only |

Platform image decoders are "accelerated", not guaranteed hardware. Most JPEG work runs on the CPU inside Skia / AppleJPEG with SIMD. HEIC uses the HEVC block. For the public API, image "hardware" means "OS codec" and "software" means "SDK-bundled portable codec" (plan D2).

Behavior differences to gate: color management (ICC → sRGB or Display P3 by default), chroma upsampling, and EXIF handling. Pixels will differ slightly from stb. OCR quality is the gate, as in the image perf plan.

---

## 4. What the benchmarks say, and what they don't

**VideoBuffer** ([ranking](../videobuffer/performance/videobuffer-android-ios-ranking.md), [findings](../videobuffer/performance/videobuffer-experiment-findings.md)):

- Kept: libyuv convert/scale/rotate (5–34×), aligned slab, I-frame table, Gray8, GOP cache, sequential iterator, encoded live ring.
- The host harness has no decoder ("Lazy 'decode' is `FillSyntheticRgb`"). Device benches measured HW seek policies only.
- **Gap:** no decode or encode throughput, no CPU cost, no SW tier at all. The SW tier cannot be ranked from existing data. It needs new benches (plan B1–B4, B6).
- What carries over: SW decoders output I420 (FFmpeg `yuv420p`) or flexible YUV (Codec2 SW). Everything downstream expects NV12 in a `FrameSlab`. libyuv `I420ToNV12` is the shared converter and is already proven fast on both platforms.

**ImageBuffer** ([ranking](../imagebuffer/performance/imagebuffer-android-ios-ranking.md), [results](../imagebuffer/performance/imagebuffer-device-bench-results.md)):

- No portable library wins at 24MP: turbo 0.56×, libyuv scale 0.33×, Wuffs 0.49×. The SW tier stays stb + libwebp. **No new SW library is missing for images.**
- Platform `ImageDecoder` 10.1× (A142P, 24MP) was rejected only because it was Android-only and not host-testable. You have now accepted that trade-off. That reopens #15, but as a policy tier, not as a replacement.
- The 10.1× was measured through the Kotlin API with `isMutableRequired = true`, returning only width/height. It does not include the RGB8 copy we must do, and it did not use `setTargetSize`. The comparison should be redone through `AImageDecoder` into our buffer (plan B7).
- iOS ImageIO 0.80× was simulator, full size, deferred-decode corrected. Thumbnail decode was never measured. A real iPhone is required (plan B8).
- Plausibility flag (not a blocker here): turbo came out at exactly 0.56× on both Android and the simulator, against literature that puts SIMD turbo ahead of stb. The harness enables SIMD through a custom `SHERPA_JPEG_WITH_SIMD` that is tied to `BITS_IN_JSAMPLE == 8` per translation unit, and SIMD activation was never logged. If turbo ever comes back, log `jsimd` dispatch first.

**Missing shared libraries, summary:**

| Need | Have | Missing |
| --- | --- | --- |
| Color conversion for every SW decoder output | libyuv (prebuilt, both platforms) | nothing; move ownership from `video/core/ColorConvert` to the shared layer |
| Android SW video decode ≤ 1080p | platform `c2.android.*` | nothing (allow-list change) |
| Android SW video encode | platform `c2.android.avc.encoder` (Level 3 caps) | nothing usable beyond ~720p without a bundled encoder; accept the limit |
| iOS SW video decode/encode, iOS 17+ / 17.4+ | VideoToolbox keys | nothing |
| SW decode for iOS < 17, > 1080p, or HW busy without platform SW | — | **FFmpeg `h264` + `hevc` decoders, opt-in variant** |
| Bundled SW H.264/HEVC encode | — | no acceptable library; out of scope |
| Image accelerated decode | `AImageDecoder` (30+), ImageIO | nothing to vendor; only new backends |

---

## 5. Design options

| Option | Summary | Verdict |
| --- | --- | --- |
| A. Per-buffer switches | each buffer adds its own HW/SW flag, pool, and error mapping | **no**: duplicates caps/slots/errors; image and video already diverge (factory vs hook) |
| B. Shared C++ codec layer | one catalog of providers (codec × direction × tier × origin, with caps), one arbiter of resource classes, one pure policy resolver, one decision/event stream; domains keep their backend interfaces | **yes** |
| C. FFmpeg as the only abstraction (`h264_mediacodec`, VideoToolbox hwaccel) | one API for HW and SW | **no**: loses control we needed for real bugs (ImageReader draining on Mali, Surface preview, create-by-name, CSD timing on MTK), bigger build, and still needs our own slot control |
| D. Platform media frameworks (Media3 Transformer, AVAssetReader/Writer) | they have built-in fallback (Media3 `EncoderSelector`, `setEnableFallback`) | **no**: Java/ObjC level, not shared C++, conflicts with the zero-copy `FrameSlab` pipeline |

Prior art for B: WebCodecs `hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software'` (a hint, not strict), Media3 encoder fallback (explicit opt-in, reports the chosen encoder), Chromium's decoder selection (try decoders in priority order, fall back on init failure, replay buffered input on early decode errors). Our variant must be **strict and observable**: `hardware` never silently becomes SW, and every fallback is reported.

---

## 6. Recommended shape (summary; details in the plan)

```
                       codec/  (shared C++, namespace sherpa_onnx::codec)
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ CodecCatalog   providers: {media, codec, direction, tier, origin,      │
 │                name, caps, buildEnabled, factoryId}                     │
 │ CodecCaps      RAM class × instance hints × overrides → limits          │
 │ CodecArbiter   resource classes (hw.video.decode.cpu, …display,         │
 │                hw.video.encode, sw.video.decode, sw.video.encode,       │
 │                platform.image.decode) → fail-fast RAII leases + events  │
 │ CodecPolicy    pure: (policy, request, catalog, arbiter state)          │
 │                → ordered candidates + skip reasons                      │
 │ CodecSelector  walks candidates, configures, returns lease + backend +  │
 │                CodecDecision {tier, origin, name, fallbackFrom}         │
 │ CodecEvents    slotFreed / fallback → one JS subscription               │
 └──────────────┬──────────────────────────────┬───────────────────────────┘
                │                              │
     video/ DecoderBackend, EncoderBackend,   image/ ImageDecodeBackend
     IVideoRenderer (preview)                 (portable stb/webp, platform
     providers: AMediaCodec(name),            AImageDecoder / ImageIO)
     VideoToolbox(hw|sw), FfmpegVideoDecoder
```

Policy vocabulary (public): `'hardware' | 'software' | 'preferHardware'`. Default: `preferHardware` for all media and uses (decided 2026-10-31, plan D1). Every fallback is reported, and `hardware` stays available as the strict mode.

---

## 7. Fallback semantics (`preferHardware`)

Falls back at session open when:

1. no HW provider exists for the codec,
2. the stream exceeds HW caps (size, profile),
3. our HW resource class is full (`VIDEO_DECODER_UNAVAILABLE` pool-full, `VIDEO_PREVIEW_DECODER_BUSY`, `VIDEO_ENCODER_UNAVAILABLE` pool-full),
4. HW create/configure fails (`createCodecByName` null, `INSUFFICIENT_RESOURCE`, VT `Require…` failure).

Mid-stream, decode only: on `AMEDIACODEC_ERROR_RECLAIMED`, `kVTInvalidSessionErr`, or a HW decode error **before the first output frame**, reopen on SW at the last keyframe ≤ the target PTS, at most once per session. Encode never switches mid-file: MP4 needs one sample description. Encode falls back only before the first packet.

Never falls back on: demux errors, `VIDEO_CODEC_UNSUPPORTED`, `VIDEO_FILE_CORRUPT`, cancel, memory budget, or HW decode errors after frames were produced (likely a bad bitstream; SW would just double the cost).

SW resources are not free. SW decode competes with the ONNX workloads (STT, OCR) that are this SDK's main load. SW classes therefore get their own small caps, and FFmpeg thread count is bounded.

---

## 8. Error model

| Situation | Code | Notes |
| --- | --- | --- |
| HW requested, unavailable (no HW / unsupported stream / configure failed / pool full) | `VIDEO_DECODER_UNAVAILABLE`, `VIDEO_PREVIEW_DECODER_BUSY`, `VIDEO_ENCODER_UNAVAILABLE` (unchanged) | add `reason`: `pool-full`, `not-present`, `unsupported-stream`, `configure-failed`, `reclaimed` |
| SW requested, bundled lib excluded by build **and** no platform SW provider | **new** `VIDEO_SW_DECODER_DISABLED` / `VIDEO_SW_ENCODER_DISABLED` | permanent; the fix is a build flag. Analog of `ERR_IMAGE_WEBP_DISABLED`, `VIDEO_FFMPEG_DISABLED` |
| SW requested, present but cannot serve (caps, pool full, configure) | same codes as HW, with `tier: 'software'` | the tier is known from the policy the caller passed |
| `preferHardware`, both tiers fail | code of the **last attempted** tier; skipped tiers listed in `attempts` | HW pool-full + SW disabled → `VIDEO_DECODER_UNAVAILABLE` (retry later) with `attempts` noting `VIDEO_SW_DECODER_DISABLED` |
| Image `software`, HEIC | **new** `ERR_IMAGE_SW_DECODER_UNAVAILABLE` | no bundled HEIC decoder |
| Image `software`, WebP, libwebp off | `ERR_IMAGE_WEBP_DISABLED` (unchanged) | `preferHardware` decodes WebP through the platform even without libwebp |
| Image `hardware`, no platform decoder (Android < 30 for non-HEIC) | **new** `ERR_IMAGE_HW_DECODER_UNAVAILABLE` | |

Transport today is `{ errorCode, errorMessage }` → `new Error("CODE: message")` with no structured details. The plan adds `codecTier`, `codecReason`, and `codecAttempts` to the native result map, and keeps the message format.

---

## 9. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Platform caps lie (SW AVC encoder above) | one deterministic rule (plan D7) + log the caps line next to every decision |
| SW decode steals CPU from ONNX | separate SW caps, bounded threads, bench B2 measures OCR latency under SW decode |
| iOS 15.1–16.x cannot be made strict | document best effort; report `tier: 'unknown'` there |
| Bundled H.264/HEVC patent exposure for adopters | opt-in variant, off by default, explicit doc note, no default flip |
| Pixel differences between image tiers move OCR boxes | OCR equivalence (B9) as a release smoke gate run by the user; a failure gets a backend fix, the `preferHardware` default stays |
| Host coverage shrinks (HW and platform image paths are device-only) | policy/arbiter/caps are pure C++ host tests; FFmpeg SW decode is host-testable with system libav; on-device conformance suite compares tiers (plan §5) |
| HEIC platform decode uses the HEVC HW block outside our pool | `platform.image.decode` class with a small cap; log concurrent video HW use |
| Preview on SW may not be real-time (HEVC 1080p SW) | gate display fallback on performance points / measured fps ≥ 1.2 × stream fps; otherwise skip with reason `sw-too-slow` |

Open, to answer with device runs (not guessable from docs): VT SW behavior and background behavior on a real iPhone; whether 1080p SW AVC encode actually configures on the A142P despite Level 3 caps; `AImageDecoder` EXIF handling; FFmpeg variant size.

---

## 10. Sources

- Android NDK r29 headers: `media/NdkMediaCodecInfo.h`, `media/NdkMediaCodecStore.h` (API 36), `media/NdkMediaError.h` (1100/1101), `android/imagedecoder.h` (API 30/31), `android/bitmap.h` (`AndroidBitmap_compress`).
- iPhoneOS 27.1 SDK: `VideoToolbox/VTDecompressionProperties.h` (L142–183), `VTCompressionProperties.h` (L782–822), `VTDecompressionSession.h` (`VTIsHardwareDecodeSupported`).
- Device: `adb shell dumpsys media.player` on A142P → [evidence](./evidence/a142p-video-codecs-2026-10-31.txt).
- Code: `VideoCodecCatalog.kt`, `AMediaCodecDecoder.cpp`, `MediaCodecSurfaceRenderer.cpp`, `VideoToolboxDecoder.mm`, `SampleBufferVideoRenderer.mm`, `DecoderPool.*`, `DecoderFactory.cpp`, `EncoderFactory.cpp`, `ImageDecoder.*`, `ImageBufferService.kt`, `SherpaOnnx+ImageBuffer.mm`, `third_party/ffmpeg_prebuilt/build_ffmpeg*.sh`.
- Harness: local `exp/imagebuffer-perf` in `/Volumes/SSD/dev/react-native-sherpa-onnx-imagebuffer` (`ImageBenchLog.kt` platform decode; `third_party/libjpeg-turbo/sherpa/`).
