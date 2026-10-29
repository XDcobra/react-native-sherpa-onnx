# VideoBuffer — implementation plan

**Status:** plan, not implemented. Branch `feat/videobuffer` (base `origin/feat/add-ocr-support`).
**Evidence:** device/simulator benches on branch `exp/videobuffer-bench-harness` (`docs/internal/videobuffer-device-bench-results.md`, `docs/future-work/videobuffer-perf-future-work.md`). The harness code is reference only; nothing is ported from it except lessons.

## 0. Requirements this plan answers

| # | Requirement | Where |
|---|---|---|
| 1 | VideoBuffer is a pipeline buffer kind; features can take it as input/output without special plumbing | §3, §9 |
| 2 | All agreed performance candidates are combined in one design | §2 |
| 3 | libyuv vendored in-tree (no GH release / workflow yet) | §4 |
| 4 | SDK unpublished: API changes allowed, no backward compatibility | throughout |
| 5 | Future `VideoPreview`/player component (play, pause, seek ±, play from position) — API prepared now, view not built | §10 |
| 6 | Robust on low-memory edge devices | §8 |
| 7 | Example app ignored | — |
| 8 | Host C++ tests prove behaviour; no device tests yet | §11 |

## 1. Decisions (fixed)

| Topic | Decision | Reason |
|---|---|---|
| Public kinds | `OfflineVideoBuffer` + `LiveVideoBuffer`, one C++ core | Same rules as audio (`offlinePcmBuffer` / `livePcmBuffer`). Stages must know at compile time whether they may seek back and whether the end is known. |
| Live lifecycle | `recording → finished` (CAS, never back). A finished live buffer is accepted by every offline API. | Mirrors `LiveBufferHandleFinished`. |
| Live ring content | HW-encoded H.264 packets (not raw YUV/Gray8) | A142P 1080p: +6.93 ms/frame encode, 0 drops, 2.6 MB vs Gray8 124 MB / YUV 187 MB. iOS assumed equal (VideoToolbox). |
| Decode / encode | Platform HW only: NDK `AMediaCodec` (Android), `VideoToolbox` (iOS). No SW fallback, no FFmpeg video decoders, no swscale. | Policy from perf doc. Unsupported codec or missing HW → `VIDEO_CODEC_UNSUPPORTED` / `VIDEO_DECODER_UNAVAILABLE`. Android emulators typically have only `c2.android.*` / `OMX.google.*` software codecs; those are excluded. Demux/index still work; frame access does not. A later, explicit exception (“software codec only if no HW codec exists **and** only on emulator”) is allowed as a future epic — **not** a silent production fallback. |
| Android CPU sink | Decoder output → `AImageReader` (`AIMAGE_FORMAT_YUV_420_888`), then copy planes into the slab. Not ByteBuffer. | Decided 2026-10-29. ByteBuffer layout is vendor-specific (incl. tiled); NDK has no `getOutputImage`. Bench cost +2–10% (A142P 1080p +1.8%, 360p +10%) accepted for robustness. Still one decoder and one CPU sink; no preview Surface. |
| Memory budgets | Architecture is fixed (§8). The MB tables are first-guess constants, overridable at init. Host tests prove **mechanism** with tiny synthetic budgets, not the production numbers. | Decided 2026-10-29. Later device benches (1080p OCR + live ingest on low-RAM phones, §12.5) may retune the numbers only. Architecture talk is required only if a bench hits one of the conflict cases in §8.1. |
| Demux (offline files) | FFmpeg `libavformat` is the **only** demuxer (`mov`, `matroska` already enabled in both prebuilts). | Battle-tested, MP4/MOV/M4V/3GP/MKV/WebM today; more containers later through `--enable-demuxer=…` only. Keyframe table comes from `stss` / Matroska Cues (no scan). Edit lists handled. One code path on both platforms, host-testable with system libav. Precedent: audio decode already uses avformat in shared C++ (`jni/audio/FfmpegFormatGuard`). |
| FFmpeg disabled | `createOfflineVideoBufferFromFile` / `ingestFileToLiveVideoBuffer` reject with `VIDEO_FFMPEG_DISABLED`. Live buffers fed by native producers keep working. | User accepts: apps enable FFmpeg when they need video files. Same pattern as `saveAudioAsFile`. |
| Live spool format | Own append-only packet log (`.vbsp`), not MP4. No demuxer involved. | We write every packet ourselves (offset, pts, dts, flags known). A log is crash-recoverable and readable while it grows; avformat cannot follow a growing file. Export to MP4 later via the avformat `mp4` muxer (already enabled). |
| Codecs v1 | H.264 (AVC) and HEVC (H.265). VP9/AV1 later (needs `vpcC`/`av1C` config + capability check). | iPhone camera default is HEVC; Android default H.264. |
| Time axis | `int64` microseconds PTS after edit list. `frameIndex` (= presentation-order sample index) is secondary. | VFR, B-frames, edit lists. |

### 1.1 License check (done 2026-10-29)

- SDK: MIT. FFmpeg prebuilts (`build_ffmpeg.sh`, `build_ffmpeg_ios.sh`): no `--enable-gpl`, no `--enable-nonfree`, no `--enable-version3` → **LGPL-2.1+**. External libs: libshine (LGPL), libopus (BSD).
- VideoBuffer uses only public avformat/avcodec-parameter APIs and already-enabled LGPL components (`mov`, `matroska`). No FFmpeg source changes. Container demuxing has no codec-patent surface; decode/encode is the OS/OEM codec.
- **Rules for the implementation:** never add `--enable-gpl`, `--enable-nonfree`, `--enable-version3`, libx264/libx265 or any GPL component. Any extra FFmpeg component (parser/bsf/demuxer) must be LGPL and is a prebuilt change (user publishes prebuilts later).
- libyuv: BSD-3-Clause + `PATENTS` grant (Google). Compatible with MIT; add to `src/licenses.ts` and ship `LICENSE` + `PATENTS` in `third_party/libyuv/`.
- Pre-existing, unchanged by this work: iOS links FFmpeg **statically** (`build_ffmpeg_ios.sh --enable-static`). LGPL static linking carries a relinking obligation for app vendors. Note it in the licensing docs; not a VideoBuffer task.

## 2. Performance candidates → design elements

Every "keep" item from the benches maps to exactly one component.

| Bench item (keep) | Component | Notes |
|---|---|---|
| libyuv convert / scale / rotate (23–34× / 5–10× / 11–17×) | `ColorConvert` | Only conversion path. No in-tree YUV math. |
| Aligned RAM (34–108×) | `AlignedBuffer`, `FrameSlab` | 64-byte base alignment, row stride rounded to 64. |
| One mmap slab, not per-frame files | `FrameSlab` | One region per cache; RAM (anonymous) below threshold, file-backed `MAP_SHARED` above. Page-cache pages are reclaimable under pressure. |
| I-frame table, never scan (17–127×) | `Timeline` built by `FfmpegDemuxer` from `AVStream` index entries; live: built on append | Open cost O(index), never O(packets). Test asserts no packet reads during open. |
| YUV/Gray8 storage, RGB once (not convert-on-Get) | `DecodedFrameCache` (NV12 slots) + derived-variant cache | Gray8 = Y plane (zero copy when no rotate/scale). RGB24 converted once per (frame, size, rotation) and cached under budget. |
| PTS + display matrix (rot90 → 270) | `Timeline`, `VideoTrackInfo.transform` | Rotation/mirror applied at conversion (libyuv rotate), cache stays unrotated. |
| GOP window cache (3.2–10×) | `DecodedFrameCache` + `DecodeSession` | Frames decoded on the way to a target are cached (budget permitting); a seek inside the same GOP reuses them. |
| Sequential iterator (2.1–5.1×) | `VideoFrameIterator` over a sticky `DecodeSession` | One seek per range; decoder kept warm. |
| Demux thinning when OCR/VLM ≠ 30 fps | `ThinningPlanner` | Skip non-reference packets that are not selected (never submitted to the decoder); keyframes-only mode; per-target cost model "decode through vs jump to next keyframe". |
| Keyframe vs accurate seek (Android 2.0–3.2×) | `SeekMode { Keyframe, Accurate, ClosestKeyframe }` | iOS sim inverted → keep Android policy, re-bench on a real iPhone. Mode is explicit per call; defaults: scrub = `ClosestKeyframe`, frame access = `Accurate`. |
| Keyframe scrub pyramid (3.6–5.2×) | `KeyframeThumbCache` | Keyframe-only decode at thumb size (longest edge ≤ 320), separate small budget, never used for analysis. |
| Encoded live ring (546× vs RGB) | `EncodedPacketRing` | GOP-granular eviction by bytes and seconds. |
| mmap container, no eager RGB | Offline entry = container + index only | Nothing decoded at create. Eager RGB hold is impossible on Android 1080p (OOM). |

Skipped on both platforms (must not appear): in-tree I420, per-frame mmap files, convert-on-Get, eager RGB hold, Surface dual-sink as the default **preview-plus-CPU** architecture. See §7.1 for the one Surface use that is deliberate (decoder → `AImageReader` as the single CPU sink).

## 3. Architecture

```
TS  src/videobuffer/*            ids, branded handles, refs, resolvers, events
     │ TurboModule (NativeSherpaOnnx.ts)
Android Kotlin  VideoBufferService ─ JNI ─┐        iOS ObjC++  SherpaOnnx+VideoBuffer.mm
                                           ▼                     ▼
C++ core  android/src/main/cpp/video/  (compiled into libsherpaonnx + the pod)
   VideoRegistry ── OfflineVideoEntry ── FfmpegDemuxer (PacketSource)
        │        └─ LiveVideoEntry ──── EncodedPacketRing + PacketSpool (PacketSource)
        ├─ DecodeSession ── DecoderBackend (interface)
        │                     ├─ android/AMediaCodecDecoder (C++, mediandk + AImageReader)
        │                     └─ ios/VideoToolboxDecoder (ObjC++)
        ├─ DecodedFrameCache ── FrameSlab ── AlignedBuffer
        ├─ ColorConvert (libyuv)
        ├─ VideoFrameAccess / VideoFrameIterator  ← features (OCR, VLM, image bridge)
        └─ VideoPacketReader                       ← future player
```

### 3.1 Source layout

```
android/src/main/cpp/video/
  VideoTypes.h                 enums, info structs, error codes, Rational, VideoTransform
  VideoLog.h                   [SherpaOnnx:video] macros (Android log / os_log / host env-gated stderr)
  core/AlignedBuffer.{h,cpp}
  core/FrameSlab.{h,cpp}
  core/FrameLease.h
  core/DecodedFrameCache.{h,cpp}
  core/KeyframeThumbCache.{h,cpp}
  core/ColorConvert.{h,cpp}
  core/Timeline.{h,cpp}
  core/PacketSource.h          interface: track info, ReadPacket(sampleIndex), codec config
  core/MemoryBudget.{h,cpp}
  core/FileIo.{h,cpp}          injectable pread/pwrite/fsync/statvfs (tests inject ENOSPC/EIO)
  demux/FfmpegDemuxer.{h,cpp}  #if HAVE_FFMPEG; else stub returning VIDEO_FFMPEG_DISABLED
  demux/BitstreamUtil.{h,cpp}  AVCC↔Annex-B, SPS/PPS/VPS extraction, nal_ref_idc / HEVC non-ref detection
  decode/DecoderBackend.h      interface + DecoderFactory registration
  decode/DecoderPool.{h,cpp}   bounded HW instances, idle close
  decode/DecodeSession.{h,cpp} seek modes, sticky forward decode, output → cache
  decode/ThinningPlanner.{h,cpp}
  encode/EncoderBackend.h      interface (raw frame → packets) for live producers
  live/EncodedPacketRing.{h,cpp}
  live/PacketSpool.{h,cpp}     segmented .vbsp writer/reader + recovery
  live/LiveVideoEntry.{h,cpp}  state machine, writer API, cursors, events
  live/LiveIngest.{h,cpp}      file → live packet remux (pacing)
  OfflineVideoEntry.{h,cpp}
  VideoRegistry.{h,cpp}
  VideoFrameAccess.{h,cpp}     AcquireFrame / iterator for features
  VideoPacketReader.{h,cpp}    packet-level reader for the player
  VideoImageBridge.{h,cpp}     video frames → ImageRegistry buffer
  platform/android/AMediaCodecDecoder.{h,cpp}
  platform/android/AMediaCodecEncoder.{h,cpp}
android/src/main/cpp/jni/video/sherpa-onnx-videobuffer-jni.cpp
android/src/main/java/com/sherpaonnx/video/{VideoBufferNative.kt, VideoBufferService.kt, VideoCodecCatalog.kt}
ios/videobuffer/{SherpaOnnx+VideoBuffer.mm, VideoToolboxDecoder.{h,mm}, VideoToolboxEncoder.{h,mm}, VideoMemoryPressure.mm}
src/videobuffer/{index.ts, types.ts, __tests__/…}
third_party/libyuv/
test/cpp/videobuffer/…
test/fixtures/videobuffer/…
```

Build wiring: Android `CMakeLists.txt` adds `video/**` (excluding nothing; `platform/android` is Android-only by path), links `mediandk` and the libyuv static target. Podspec globs `android/src/main/cpp/video/**/*.{h,cpp}` and excludes `video/platform/android/**`, `jni/video/**`; adds `VideoToolbox`, `CoreMedia`, `CoreVideo`.

## 4. libyuv vendoring

- Location: `third_party/libyuv/` (`include/`, `source/`, `LICENSE`, `PATENTS`, `README.sherpa.md`). Plain files, not a submodule.
- Re-vendor fresh from upstream `https://chromium.googlesource.com/libyuv/libyuv` at a **pinned commit**; record commit hash, date, excluded files and "no local modifications" in `README.sherpa.md`. Do not reuse `third_party/throwaway-libyuv` (version 1975, unpinned revision).
- Excluded sources: `convert_jpeg.cc`, `mjpeg_decoder.cc`, `mjpeg_validate.cc`; backends not targeted (`*_lsx`, `*_lasx`, `*_hvx`, `*_rvv`, `*_wasm`). Keep `*_win.cc` (32-bit x86 SSE lives there — harness lesson for the `x86` ABI). Defines: `LIBYUV_DISABLE_JPEG` plus disables for excluded backends.
- **ISA flags (crash risk, must get right):** the harness used `-march=armv8-a+dotprod+i8mm` globally on iOS. That is unsafe: the compiler may emit `udot`/`usdot` anywhere and SIGILL on CPUs without dotprod (iOS 15.1 floor includes A9–A12; Android ARMv8.0 Cortex-A53 devices).
  - Android: mirror upstream libyuv's own CMake split — ISA flags only on the files upstream compiles with them; everything else plain `armv8-a`.
  - iOS: libyuv as a CocoaPods **subspec** (`SherpaOnnx/libyuv`) so `compiler_flags` apply only to those files; no ISA flags on SDK code.
  - Acceptance: a build check script disassembles the SDK objects (`llvm-objdump`) and fails if `udot`/`usdot`/`smmla` appear outside libyuv's dispatched NEON files. Device verification on an ARMv8.0 Android device and an A12 iPhone is in §12.
- Thin wrapper `ColorConvert` is the only caller. API:
  - `Nv12ToRgb24(src, dst, matrix, range)`, `Nv12ToGray8(...)` (Y copy/rotate), `ScaleNv12(...)`, `Rotate(...)` with `VideoTransform` (0/90/180/270 + horizontal mirror).
  - Color matrix from container/VUI (`AVCodecParameters::color_space/color_range`, VT format description); when unspecified: BT.709 for height ≥ 720, else BT.601; range limited unless flagged full. Maps to libyuv `kYuvI601Constants`, `kYuvH709Constants`, `kYuvJPEGConstants`, `kYuvV709Constants`, `kYuv2020Constants`.

## 5. Core types and C++ API

### 5.1 Track info and timeline

```cpp
enum class VideoCodec { H264, Hevc };
struct VideoTransform { int rotationDegrees = 0; bool mirrorHorizontal = false; };
struct VideoTrackInfo {
  VideoCodec codec; int codedWidth, codedHeight; int displayWidth, displayHeight; // after transform
  VideoTransform transform; ColorMatrix matrix; ColorRange range;
  Rational nominalFps; bool variableFrameRate;
  std::vector<uint8_t> codecConfig;   // avcC / hvcC
};
struct SampleEntry { int64_t ptsUs, dtsUs; int64_t fileOffset; uint32_t size; uint32_t flags; }; // Key, NonRef, Discontinuity
class Timeline {
  // presentation-ordered view + decode-ordered view
  int64_t SampleAtPts(int64_t tUs) const;            // frame whose [pts_i, pts_{i+1}) contains t
  int64_t KeyframeAtOrBefore(int64_t sampleIdx) const;
  int64_t ClosestKeyframe(int64_t tUs) const;
  std::vector<int64_t> KeyframeTimes(int64_t fromUs, int64_t toUs, size_t maxCount) const;
  int64_t startUs() const; int64_t endUs() const; int64_t frameCount() const;
};
```

Offline timeline is immutable after open. Live timeline is append-only (segment-chunked vectors, so readers never see reallocation; readers take a consistent `(size, generation)` snapshot).

### 5.2 Frame access for features

```cpp
enum class VideoPixelFormat { Nv12, Gray8, Rgb24 };
enum class SeekMode { Keyframe, Accurate, ClosestKeyframe };
struct FrameRequest { int64_t ptsUs; SeekMode mode = SeekMode::Accurate; VideoPixelFormat format;
                      int maxSide = 0; bool applyTransform = true; bool packed = false; };
struct VideoFrameView { const uint8_t* plane[3]; int stride[3]; int width, height;
                        VideoPixelFormat format; int64_t ptsUs; int64_t frameIndex; };
class VideoFrameLease { /* move-only RAII pin; view valid until destroyed, even across Release() */ };

Result<VideoFrameLease> VideoFrameAccess::Acquire(const std::string& bufferId, const FrameRequest&);
Result<VideoFrameIterator> VideoFrameAccess::Iterate(const std::string& bufferId, const IterateRequest&);
// IterateRequest: [startUs, endUs], sampling {All | Fps(f) | StrideUs(s) | Keyframes | Uniform(n) | Times(list)},
//                 format, maxSide, lagPolicy (live only)
```

- `packed = true` guarantees `stride == width * bpp` (OCR's `OcrFrameView` expects unpadded RGB).
- Leases are what makes this safe where `ImageRegistry::GetFrameRgbPtr` is not: a pinned slot is never evicted or unmapped; `Release()` of the buffer defers slab teardown until the last lease drops (entries are `shared_ptr`).

### 5.3 Errors (string codes, no exceptions across module boundaries)

`VIDEO_INVALID_ARGUMENT`, `VIDEO_BUFFER_NOT_FOUND`, `VIDEO_BUFFER_KIND_MISMATCH`, `VIDEO_BUFFER_INVALID_STATE`, `VIDEO_FFMPEG_DISABLED`, `VIDEO_CONTAINER_UNSUPPORTED`, `VIDEO_NO_VIDEO_TRACK`, `VIDEO_CODEC_UNSUPPORTED`, `VIDEO_DECODER_UNAVAILABLE`, `VIDEO_DECODE_FAILED`, `VIDEO_FRAME_OUT_OF_RANGE`, `VIDEO_FRAME_EVICTED` (carries available range), `VIDEO_MEMORY_BUDGET_EXCEEDED`, `VIDEO_SPOOL_IO`, `VIDEO_CANCELLED`, `VIDEO_FILE_CORRUPT`.

## 6. Offline path

1. `FfmpegDemuxer::Open(path)`: one `avformat_open_input` with explicit probing limits; no `avformat_find_stream_info` decoding (no video decoders exist in the prebuilt). Select the first video stream; reject audio-only (`VIDEO_NO_VIDEO_TRACK`).
2. Build `Timeline` from the stream index (`avformat_index_get_entries_count` / `avformat_index_get_entry`), `AVStream::time_base`, edit list already applied by the mov demuxer. Display matrix from `AV_PKT_DATA_DISPLAYMATRIX` side data → `VideoTransform`. Codec config from `codecpar->extradata`.
   - **MP4/MOV:** the mov index holds every sample (pts, pos, size, key flag) → exact full timeline at open, `frameCountExact: true`.
   - **Matroska/WebM:** Cues list keyframes only → keyframe table exact at open; per-frame entries of a GOP are filled the first time that GOP is read (packet headers only, no decode) and cached; `frameCount` is an estimate until all GOPs are known (`frameCountExact: false`). A file without Cues is opened with a background header-only index pass; seeks before it completes wait or use the partial table (`indexState: 'building' | 'complete'` in info).
3. Packet reads, one rule per container decided at open (logged, never a runtime retry): mov → `FileIo::pread(pos, size)` from the index; matroska → `av_seek_frame` to the keyframe + `av_read_frame` (lacing/cluster layout).
4. `BitstreamUtil` converts AVCC length prefixes to Annex-B for MediaCodec; VideoToolbox consumes AVCC directly.
5. Create returns immediately after indexing; nothing is decoded (`state: 'immutable'`, `storageKind: 'container'`).

## 7. Decode path

### 7.1 Backends

- **Android (`AMediaCodecDecoder`, C++):** NDK `AMediaCodec` in synchronous mode (minSdk 24), output to an `AImageReader` (`AIMAGE_FORMAT_YUV_420_888`, API 24) as the **single** CPU sink. Planes are copied into slab slots with libyuv `Android420ToI420`/`NV12` handling `pixelStride` 1/2.
  - Why not ByteBuffer output (**decided 2026-10-29**): in NDK there is no `getOutputImage`; ByteBuffer layout depends on vendor color formats (incl. tiled). The measured 2–10% (A142P 1080p +1.8%, 360p +10%) is accepted. **This deviates from the bench "dual sink: no" row only in mechanism** — there is still one decoder and one CPU sink; no preview Surface.
  - HW-only selection: `VideoCodecCatalog.kt` enumerates `MediaCodecList` once at init (`isHardwareAccelerated` on API 29+, name rules `c2.android.*`/`OMX.google.*` excluded below 29) and passes allowed decoder/encoder names to C++. Create by name.
  - **Emulator (decided 2026-10-29):** AVDs typically expose only those excluded software codecs. Opening a file, building the I-frame index, and live packet append/ring/spool still work. `AcquireFrame`, export, image bridge, player, and HW encode return `VIDEO_DECODER_UNAVAILABLE` / `VIDEO_CODEC_UNSUPPORTED`. Host tests are unaffected (`FakeDecoderBackend`). iOS Simulator is a different case: VideoToolbox on Apple Silicon often really hardware-decodes. No silent software fallback in this epic. A later epic may add an **explicit** exception: software codec only if no HW codec exists **and** only on emulator.
- **iOS (`VideoToolboxDecoder.mm`):** `VTDecompressionSession` from `CMVideoFormatDescriptionCreateFromH264/HEVCParameterSets`; output `kCVPixelFormatType_420YpCbCr8BiPlanar{Video,Full}Range`; lock, copy planes into slab slot, unlock. HW check with `VTIsHardwareDecodeSupported`.
- **Host:** `FakeDecoderBackend` (tests) decodes synthetic packets (§11.2) and enforces real decoder rules (must start at a keyframe, P depends on previous decoded reference, B reorders), so seek bugs fail tests.

### 7.2 DecoderPool

HW decoder instances are scarce. Pool with `maxSessions` (default 2, configurable), idle close after 5 s, waiters time out with `VIDEO_DECODER_UNAVAILABLE`. Sessions are keyed by buffer; a sticky session keeps its position for sequential access.

### 7.3 DecodeSession

- `Seek(target, mode)`: keyframe = `KeyframeAtOrBefore`; reuse the current decoder position when the target lies ahead within the same GOP (no flush).
- Forward decode emits frames into `DecodedFrameCache`; frames other than the target are inserted only when budget allows (nearest-to-target preferred).
- Output frame identity is matched by PTS against the timeline (handles B-frame reordering).
- Generation check after every unlocked decode step; a released buffer aborts with `VIDEO_CANCELLED`.

### 7.4 ThinningPlanner

Input: selected sample set. Output: packet submission plan.
- Non-reference packets (H.264 `nal_ref_idc == 0`, HEVC non-reference NAL types) that are not selected are never submitted.
- For each next target: cost(decode-through) = reference packets between; cost(jump) = packets from its keyframe. Choose the cheaper; ties → decode-through.
- `Keyframes` sampling submits keyframes only.
- Deterministic and unit-tested by counting submitted packets.

## 8. Memory and robustness

| Concern | Mechanism |
|---|---|
| Decoded RAM bound | Global `MemoryBudget` across all video buffers. Defaults by RAM class (same classes as `ImageMmapThreshold`): Low 24 MB, Mid 48 MB, High 96 MB, VeryHigh 160 MB. Overridable via init options. Pinned bytes count against it. These MB values are **first-guess constants** (§8.1), not bench results. |
| Cache resolution | Cache stores frames at the requested analysis size bucket (`maxSide` rounded up to 320/640/960/1280/full) so a 1080p GOP does not cost 93 MB on a low-RAM phone. |
| Spill | `FrameSlab` switches from anonymous RAM to a file-backed mmap above the RAM-class threshold; page-cache pages are reclaimable by the OS instead of counting toward OOM. |
| Budget exhausted by pins | `VIDEO_MEMORY_BUDGET_EXCEEDED`, never unbounded growth. |
| OS memory pressure | Android `ComponentCallbacks2.onTrimMemory` → `VideoRegistry::OnMemoryPressure(level)`; iOS `UIApplicationDidReceiveMemoryWarningNotification` + `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`. Effects: drop thumb cache, shrink decoded caches to pinned + current target, trim live ring to the newest GOP when a spool backs it, close idle decoders. |
| Live ring bound | Per buffer: `ringSeconds` (default 10) **and** `ringMaxBytes` (Low 16 / Mid 32 / High 64 / VeryHigh 96 MB, first-guess constants); evict whole GOPs only; never below one GOP. |
| Disk | `statvfs` check before spool creation and at segment rotation; ENOSPC/EIO → stop spooling, emit `spoolError`, buffer continues ring-only, info reports `hasActiveSpool: false`. |
| Spool writer stalls | Dedicated writer thread with bounded queue. On overflow: drop packets until the next keyframe, mark a `Discontinuity` in the timeline, emit `spoolOverflow`. Producers never block (camera is realtime). |
| Size limits | All offsets/counts `int64`; spool segmented (default 10 s or 256 MB per segment) — no 2/4 GiB edge. |
| Crash leftovers | All temp files prefixed `vid_` (`vid_slab_<uuid>.bin`, `vid_live_<uuid>_s<NNNN>.vbsp`); orphan sweep at init (> 1 h old). Fixes the audio leak (`live_spool_*.wav` not swept). |
| Names | UUIDv4 everywhere; no timestamp names (audio collision bug). |
| Release races | `shared_ptr` entries + leases + generation counter; release during decode or read is safe. |
| Concurrency | Registry mutex guards the map only; per-entry mutex; decode and IO outside locks; ring append and spool enqueue ordered under the same entry lock (audio multi-producer bug). |

### 8.1 Budget numbers vs architecture (decided 2026-10-29)

Host tests in this epic prove the **mechanism** with tiny synthetic budgets (e.g. 2 MB) so eviction, pins, pressure, and `VIDEO_MEMORY_BUDGET_EXCEEDED` fire. They do **not** validate the production MB tables.

Later device benches (§12.5: 1080p OCR + live ingest on a low-RAM phone, peak RSS, drop counts, whether OCR still gets frames) may **retune the constants only**. Same pattern as `ImageMmapThreshold` (6/10 MB bases, 4–32 MB clamp). No architecture change.

Talk again before changing design only if a bench hits one of:

- A 1080p GOP plus one pinned OCR frame does not fit even after the analysis-size ladder (320/640/960/…) → cache ladder or “at least one GOP” rule is wrong.
- A 16 MB live ring cannot hold a single 1080p encoded GOP → `ringMaxBytes` vs “never below one GOP” conflict.
- Memory pressure is so frequent that OCR sees `VIDEO_MEMORY_BUDGET_EXCEEDED` as the steady state → pinning strategy, not the table.

## 9. Live path

### 9.1 Writer side (C++)

```cpp
class LiveVideoWriter {               // obtained from LiveVideoEntry
  Status SetCodecConfig(VideoCodec, std::span<const uint8_t> avccOrHvcc, const VideoTrackInfo&);
  Status AppendPacket(const EncodedPacket&); // pts/dts µs, key flag, AVCC payload
  Status Finish();                            // CAS recording→finished, flush spool, wake readers
};
```

- Packets before the first keyframe are dropped (counted in info).
- Producers this epic: `LiveIngest` (file → live remux, `pacing: 'realtime' | 'asFast'`, no transcoding) and the native writer API for future camera code. `EncoderBackend` (`AMediaCodecEncoder` with input Surface/ByteBuffer, `VideoToolboxEncoder`) is implemented and exposed natively for `AppendRawFrame`; camera capture itself is a later epic.

### 9.2 Ring + spool

- Ring = newest packets in RAM (hot cache). Spool = full durable log when retention ≠ `none`.
- Retention: `'session'` (default; temp spool, deleted on release), `'none'` (ring only), `{ mode: 'maxSeconds', seconds }` (rolling: delete oldest segments), `{ mode: 'path', directory }` (persist; caller owns files).
- `.vbsp` v1 segment: file header (magic, version, codec, codec config, track info) + records `[magic u32][len u32][pts i64][dts i64][flags u32][crc32 u32][payload]`. Each segment starts at a keyframe. Recovery: scan records, stop at the first bad length/CRC, truncate to the last complete GOP.
- Read path: ring when the sample is resident, else spool `pread`, else `VIDEO_FRAME_EVICTED { availableStartUs, availableEndUs }`.

### 9.3 Consumers

- `LiveVideoCursor`: absolute sample index; `lagPolicy: 'dropToLatestKeyframe'` (default for live OCR), `'error'`, `'block'` (only valid with `LiveIngest pacing: 'asFast'`).
- Live OCR uses the iterator + sticky decoder + decoded LRU, never independent random Gets (171 ms per Get measured on the encoded ring).
- Events (metadata only, throttled via `StreamEventSpec`): `packetsAppended { liveBufferId, frameCount, totalFramesWritten, liveEdgeUs }`, `gopCommitted`, `spoolOverflow`, `spoolError`, `finished`.

## 10. Player preparation (view not built)

The future `VideoPreview` consumes **encoded packets** and renders through the platform decoder directly into a surface (Android `MediaCodec` → `TextureView`/`SurfaceView`; iOS `AVSampleBufferDisplayLayer` or VT → layer). No CPU RGB per frame (ImagePreview-style bitmap pumping cannot reach 30 fps).

Prepared now:
- `VideoPacketReader` (C++): `SeekToKeyframe(tUs)`, `Next(timeoutMs)` returning packets in decode order, codec config, `Discontinuity` markers; tail mode on live buffers waits for appends and wakes on `Finish()` with EOS.
- `VideoBufferInfo.seekableRange { startUs, endUs }`, `liveEdgeUs`, `ringRange`, `spoolRange`, `state`.
- `getVideoKeyframeTimes(range, maxCount)` for timeline marks/scrubbing; `KeyframeThumbCache` for scrub thumbnails.

Behaviour contract the player will implement:

| Case | Behaviour |
|---|---|
| Offline: play from t | `SeekToKeyframe(t)`, decode, drop frames with pts < t (accurate start). |
| Scrub | `ClosestKeyframe` + thumbnails while dragging; accurate frame on release. |
| Live recording, target inside `seekableRange` | Normal seek (ring fast, spool slow). |
| Live, target older than `seekableRange.startUs` (ring-only retention, evicted) | Clamp to start, emit `seekClamped { requestedUs, actualUs }`. |
| Live, target after live edge | Clamp to live edge. |
| Paused live player overtaken by eviction | Reader returns `VIDEO_FRAME_EVICTED`; player jumps to oldest available keyframe and emits `positionEvicted`. |
| Live finished with spool | Identical to offline. |

`VideoPlaybackController` (pure C++ state machine with injected clock: idle/playing/paused/seeking/buffering/ended, rate, live-edge follow) is specified here and built with the view epic.

## 11. Pipeline integration

### 11.1 TypeScript (`react-native-sherpa-onnx/videobuffer`)

- Kinds: `PipelineVideoBufferKind = 'offlineVideoBuffer' | 'liveVideoBuffer'`. Ids `vid_off_<uuid>`, `vid_live_<uuid>`.
- Handles: `OfflineVideoBufferHandle`, `LiveVideoBufferHandleRecording`, `LiveVideoBufferHandleFinished` (+ unions), refs, `*IdSource` types, resolvers `resolveOfflineVideoBufferId` (accepts finished live), `resolveLiveVideoBufferId`, `resolvePipelineVideoBufferId`.
- API: `createOfflineVideoBufferFromFile(FileSource, { signal, onProgress })`, `createEmptyLiveVideoBuffer(opts)`, `ingestFileToLiveVideoBuffer(file, live, opts)`, `finalizeLiveVideoBuffer`, `getVideoBufferInfo`, `getVideoKeyframeTimes`, `subscribeLiveVideoBufferEvents`, `releaseVideoBuffer`, `exportVideoFrame(video, ptsUs, FileDestination, { format, maxSide, mode })`, `createOfflineImageBufferFromVideo(video, { sampling, mode, maxSide })`.
- `package.json` export + `tsconfig` path; `src/licenses.ts` libyuv entry; `docs/disable-ffmpeg.md` lists the FFmpeg-dependent video APIs.

### 11.2 Video → existing features now

- `VideoImageBridge`: frames → `ImageRegistry` (heap-origin, mmap upgrade rules unchanged). New optional `OfflineImageFrameInfo.source = { videoBufferId, ptsUs, frameIndex }`.
- OCR on a video-derived image buffer fills `TextSpatialSpan.ptsMs` from the frame source (field exists, unused today) → overlays sync to video time. Small change in the OCR helpers on both platforms.
- Future direct video features (live OCR, video VLM) consume `VideoFrameAccess` / `LiveVideoCursor` natively and register as `StreamingPipelineWorker` (`units` = frames). A `'video'` live-overload domain and a `CommittedSegmentVideo` variant are added by the first such feature, not now.

### 11.3 Native bridges

- Android: `VideoBufferService.ensureInitialized(context)` (cache dir `sherpa-video`, total RAM, codec catalog, `onTrimMemory` registration), `VideoBufferNative.kt` externals, `SherpaOnnxModule` overrides, events via `RCTDeviceEventEmitter`.
- iOS: `SherpaOnnx (VideoBuffer)` category with `std::call_once` init (`NSTemporaryDirectory()/sherpa-video`), memory-pressure observer, events in `supportedEvents`.
- TurboModule spec entries in `src/NativeSherpaOnnx.ts` (codegen structs for options — iOS signature must use `JS::NativeSherpaOnnx::Spec…Options &`, never `NSDictionary *`; harness crash lesson).

## 12. Tests

### 12.1 Host C++ (`test/cpp/videobuffer/`, GTest, `WORKING_DIRECTORY` repo root)

Two executables so the core does not need FFmpeg:
- `videobuffer_core_host_test` (no FFmpeg): convert, slab, cache, budget, pressure, timeline, seek, thinning, iterator, ring, spool, live state machine, cursors, packet reader, registry, image bridge — all with synthetic streams + `FakeDecoderBackend`.
- `videobuffer_demux_host_test` (system libav via pkg-config, like `audio_f32le_to_format_host_test`): real fixtures through `FfmpegDemuxer`, `LiveIngest`.
- Optional `videobuffer_vt_host_test` (macOS only): compiles `ios/videobuffer/VideoToolboxDecoder.mm` (no UIKit) and decodes the H.264/HEVC fixtures on the Mac → real decode of the iOS backend without a device. Skipped elsewhere.

| Area | Must prove |
|---|---|
| ColorConvert | NV12→RGB24 vs reference formula (±2) for 601/709/JPEG/2020 × limited/full; rotate 90/180/270 + mirror; scale dims; Gray8 == Y; strides/alignment honoured; packed output. |
| FrameSlab | RAM below / mmap above threshold; slot reuse; 64-byte alignment; unlink on release; sparse offsets > 4 GiB. |
| DecodedFrameCache | GOP reuse (decoded count == unique frames, not gets); LRU order; budget never exceeded; pinned slots survive eviction and buffer release; `OnMemoryPressure` shrinks to pinned. |
| Timeline | `SampleAtPts` boundaries; VFR; B-frame pts≠dts; edit-list offset; `KeyframeAtOrBefore` / `ClosestKeyframe`; out-of-range. |
| DecodeSession | Decoder never receives a non-key first packet; accurate returns exact pts; keyframe mode decodes 1 frame; same-GOP forward seek does not flush; release mid-decode → `VIDEO_CANCELLED`. |
| ThinningPlanner / iterator | Submitted packet counts for All / Fps(2) / Keyframes / Uniform; non-ref skip; jump-vs-through choice; one seek per range. |
| Demux (fixtures) | Keyframe table and pts equal `ffprobe` expectations; MP4 open reads no packet payloads (AVIO byte counter); MKV per-GOP fill and `frameCountExact` transitions; cue-less MKV `indexState` building → complete; rot90 → 270 transform; HEVC config; MKV; fragmented MP4; edit list; audio-only → `VIDEO_NO_VIDEO_TRACK`; VP9 WebM → `VIDEO_CODEC_UNSUPPORTED`; truncated/garbage/bit-flipped files → clean error, no crash (ASan). |
| EncodedPacketRing | Drops until first key; GOP-granular eviction by seconds and bytes; never splits a GOP; counters monotonic. |
| PacketSpool | Round trip; segment rotation at keyframes; crash recovery after truncation mid-record and CRC damage; `maxSeconds` deletes oldest segments; injected ENOSPC → ring-only + event; overflow → drop-to-next-key + discontinuity; orphan sweep. |
| LiveVideoEntry | CAS recording→finished; append after finish rejected; finished accepted by offline APIs; recording rejected where offline-only; `VIDEO_FRAME_EVICTED` with range; events throttled and metadata-only. |
| Cursor / reader | `dropToLatestKeyframe`, `error`, `block`; tail wait wakes on append and on finish (EOS); one writer + several readers race-free under TSan. |
| Registry | Id prefixes; release while leased; generation invalidation; concurrent create/release stress; sweep. |
| Image bridge | Frames land in `ImageRegistry` with `source.ptsUs`; sampling modes. |

Sanitizer presets: `-DVIDEOBUFFER_SANITIZE=address` (ASan+UBSan) and `=thread` (TSan) for the core executable.

### 12.2 Fixtures (`test/fixtures/videobuffer/`)

- `generate.sh` (dev machine with ffmpeg+libx264+libx265; outputs committed, < 2 MB total) + `expected/*.json` from `ffprobe`.
- Frames carry identity: raw Y4M generated by a script with per-frame luma `16 + (i * 7) % 220`, encoded → decoded frame `i` is identifiable after any seek (used by the macOS VT test).
- Set: H.264 MP4 GOP 15 with B-frames; same with rot90 matrix; VFR; edit list; fragmented MP4; HEVC MOV (`hvc1`); H.264 MKV; VP9 WebM; audio-only M4A; truncated MP4.

### 12.3 Fidelity with the shipped FFmpeg

System libav has every component; the prebuilt is minimal. `scripts/build-host-ffmpeg-minimal.sh` builds `third_party/ffmpeg` for the host with the **same** `--disable-everything` / demuxer flags as the prebuilts; `-DVIDEOBUFFER_FFMPEG=minimal` runs the demux tests against it. Goal: zero FFmpeg configure changes. If a parser/bsf proves necessary, it is LGPL-only and becomes a prebuilt change for the user.

### 12.4 JS

Jest tests for id resolvers, branding, finished-live acceptance, event parsing (`src/videobuffer/__tests__/`).

### 12.5 Not now (device, later by the user)

HW decode/encode on Android (A142P + an ARMv8.0 device for the libyuv ISA check), iOS device (A12 + current), decoder instance limits, memory pressure under real trim, thermal over 60 s live ingest, iOS seek/pyramid/thinning re-bench.

Budget-number retune (not architecture): 1080p OCR + live ingest on a low-RAM phone; peak RSS; drop counts; whether OCR still gets frames. Outcome expected to be one-liner constant changes in the §8 tables (§8.1).

Android emulator decode/encode is out of scope until a later epic adds the explicit software-codec-on-emulator-only exception. Functional decode checks run on a real phone.

## 13. Logging (debug-first)

Stable tag `[SherpaOnnx:video]` (+ sub-tags `video.demux`, `video.decode`, `video.cache`, `video.live`, `video.spool`). Android log in all builds for errors; info/debug gated by a runtime flag enabled in `__DEV__` from TS. Log at: open (container, codec, frames, keyframes, index ms), seek (mode, target, keyframe, decoded count, cache hit/miss), eviction (reason, bytes), budget/pressure transitions, decoder acquire/release/wait, live append/evict/rotate/recovery/overflow, state transitions, release (generation).

## 14. Implementation phases

Each phase ends green on host tests and hooks; one commit series per phase.

1. **Foundation** — vendor libyuv (pinned), build wiring (CMake static target, podspec subspec, ISA check script), `VideoTypes`, `VideoLog`, `AlignedBuffer`, `ColorConvert`, `FileIo`; test CMake skeleton + convert tests.
2. **Timeline + demux** — `Timeline`, `PacketSource`, `BitstreamUtil`, `FfmpegDemuxer`, fixtures + generator, demux tests, minimal-FFmpeg host build.
3. **Decode core** — `DecoderBackend`, `FakeDecoderBackend`, `DecoderPool`, `FrameSlab`, `MemoryBudget`, `DecodedFrameCache`, `FrameLease`, `DecodeSession`, `ThinningPlanner`, `KeyframeThumbCache`; tests incl. ASan.
4. **Offline registry** — `OfflineVideoEntry`, `VideoRegistry`, `VideoFrameAccess`, iterator, `VideoImageBridge`; tests.
5. **Live** — `EncodedPacketRing`, `PacketSpool`, `LiveVideoEntry`, cursors, `LiveIngest`, `VideoPacketReader`; tests incl. TSan.
6. **Platform backends** — Android `AMediaCodecDecoder`/`Encoder` + `VideoCodecCatalog`; iOS `VideoToolboxDecoder`/`Encoder`; optional macOS VT host test. Compile-verified for all ABIs + iOS device/sim; runtime verification is §12.5.
7. **Bridges + TS** — JNI, Kotlin service (incl. `onTrimMemory`), module overrides; ObjC++ category + memory pressure; TurboModule spec; `src/videobuffer`; jest tests; package exports.
8. **Pipeline integration + docs** — image bridge API, OCR `ptsMs`, `docs/videobuffer.md` (public), `docs/internal/videobuffer-internal.md` (storage, spool format, invariants), licenses, disable-ffmpeg table.

## 15. Closed 2026-10-29 (was: open points before phase 6)

All three former open points are decided. Phase 6 implements them as written; no further confirmation needed.

| Point | Decision |
|---|---|
| Android CPU sink | `AImageReader`. The 2–10 % vs ByteBuffer is accepted. |
| Memory budgets | Ship the first-guess tables. Host tests cover mechanism. Later device benches retune numbers only, not architecture (§8.1). |
| Emulator | HW-only, no silent fallback. Demux/index/live-packets work on AVDs; decode/encode do not. A future epic may add an explicit “software codec only if no HW exists **and** only on emulator” exception. |
