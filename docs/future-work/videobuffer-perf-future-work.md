# VideoBuffer — video-specific performance (future work)

**Status:** Candidates only — **not implemented, not measured.** Host RGB-layout benches in [`docs/internal/videobuffer/performance/videobuffer-experiment-findings.md`](../internal/videobuffer/performance/videobuffer-experiment-findings.md) cover mmap/zero-copy/lazy-RGB/ring (Image/Audio analogs). This list is the **video-only** layer on top: demux, GOP, seek, decode, color, dual sink.  
**Decision rule:** each item gets a test vs a named baseline; ship only if the gate in that section holds.  
**SOT:** C++ `VideoRegistry` (Android + iOS wrappers later).  
**Constraint:** shipped FFmpeg is **audio-only** (`--disable-everything`, no H.264/HEVC, `--disable-swscale`). Decoder-backed tests need a host FFmpeg with video, a fixture GOP stream, and/or a device (MediaCodec / VideoToolbox).

Image analog (do not duplicate here): [`imagebuffer-perf-future-work.md`](./imagebuffer-perf-future-work.md).

---

## Scoreboard (fill after tests)

| # | Candidate | Hypothesis | Host? | Device? | Result | Ship? |
|---|-----------|------------|-------|---------|--------|-------|
| 1 | Container mmap as compressed retain | RAM ≪ eager RGB; first sample ≪ full decode | yes* | later | | |
| 2 | Keyframe index + seek modes | Random seek ms ↓ vs linear scan; `accurate` vs `keyframe` tradeoff | yes* | later | | |
| 3 | GOP window cache | Nearby scrub ≪ random GOP; better than N independent RGB slots | yes* | later | | |
| 4 | Dual sink (Surface + CPU) | 30 fps preview without Bitmap copies; OCR still gets CPU frames | no | **yes** | | |
| 5 | Y-plane as Gray8 | ~67% less payload, ~0 convert vs RGB→gray | yes | later | | |
| 6 | Thinning before decode | Decode time ~ proportional to kept frames, not file fps | yes* | later | | |
| 7 | Scrub pyramid vs analysis res | Drag seek cheap; pause/OCR full res | yes* | **yes** (UI) | | |
| 8 | Sequential full-scan iterator | Whole-video VLM/OCR without materializing all RGB | yes* | later | | |
| 9 | PTS / VFR / display-matrix / range | Correct time + contrast; not a throughput trick | yes* | later | | |
| 10 | Live encoded/HW ring | Bound RAM at 4K capture; RGB ring OOM | partial | **yes** | | |
| 11 | **libyuv** vs in-tree YUV convert | NV12→RGB / scale / rotate ≪ naive C; convert share vs decode | yes | **yes** | | |

\*Host needs a real bitstream or a synthetic GOP (I every N, P in between) that models decode-forward cost. RGB-only slabs **cannot** accept or reject 1–3, 6–8.

---

## 1. Container mmap as compressed retain

**What.** Keep the original MP4/MKV as the buffer backing (seekable file handle / `mmap` of the container). Decode pixels only for frames that OCR, VLM, or preview actually need. Do **not** explode the file into per-frame JPEG/RGB.

**Why video-specific.** Image compressed-retain is “keep JPEG bytes.” Video’s compressed form is a **temporal GOP stream**, not a folder of stills. Per-frame JPEG is larger, has no seek index, and throws away B/P-frame compression.

**Baseline.** Eager decode-all → RGB slab (current host `ram_rgb` / `mmap_slab`).

**Metrics.** Peak RSS after `createFromFile`; time-to-first-`EnsureAt(pts)`; disk bytes vs `duration × fps × w × h × 3`.

**Gate.** Ship if RSS stays on the order of **file size + GOP window**, not **full RGB**, and first sample is much cheaper than decode-all. Reject if open+index already ≈ decode-all (tiny clips).

---

## 2. Keyframe index + seek modes

**What.** At open (or lazily): list of I-frame PTS → byte offset. API:

- `seek(pts, { accuracy: 'keyframe' | 'accurate' })`
- `seekFrame(i, …)` only as a helper; **PTS is the axis** (see §9)

`keyframe` = jump to nearest IDR (scrub). `accurate` = IDR + decode forward to PTS (OCR / pause).

**Why video-specific.** Image/PDF frame `i` is O(1) if hot. H.264/HEVC random access is “find IDR, decode 0–GOP”. Without an index every slider jump scans the file.

**Baseline.** `av_seek_frame` / extractor seek **without** a precomputed I-frame table; vs sequential `readNext` from 0.

**Metrics.** p50/p95 ms for 64 random seeks (`keyframe` and `accurate`) on 30–120 s 720p/1080p; index build ms and bytes; wrong-PTS rate for `accurate`.

**Gate.** Ship index if random `keyframe` seek is **≫** faster than file scan (expect an order of magnitude on long clips). Keep both accuracy modes if `accurate` is needed for OCR and costs ~GOP length (acceptable). Reject a heavy index if open latency dominates short clips (make index lazy).

---

## 3. GOP window cache (not independent RGB LRU)

**What.** Cache the **currently decoded GOP** (optionally ±1), not `hotFrames` independent RGB slots like PDF. A seek inside the same GOP reuses decoded frames; a seek into another GOP drops the window and decodes forward from that IDR.

**Why video-specific.** PDF page 7 does not depend on page 6. Frame 47 may require frames 40–47. Image `hotFrames=8` on random timestamps will re-decode the same GOP over and over.

**Baseline.** PDF-style LRU of 8 RGB frames keyed only by frame index; vs no cache (decode from IDR every Get).

**Metrics.** Scrub pattern (monotonic ±2 s, then jump 20 s): decode-frame count, ms, RSS. OCR pattern (stride 15 inside one GOP vs across GOPs).

**Gate.** Ship if nearby scrub/OCR **reuses** decode (decode-frame count ≈ unique frames, not ≈ gets). Reject if GOP cache RSS ≈ eager clip and wins nothing on random access (then lazy-per-sample is enough).

---

## 4. Dual sink: Surface preview + CPU analysis

**What.** Same buffer/file, two outputs:

- **Preview/player:** HW Surface / TextureView / AVPlayerLayer (no RGB memcpy per frame).
- **OCR/VLM:** CPU buffer (YUV or RGB), often at `maxSide` and lower fps.

**Why video-specific.** `OfflineImageBufferFrameView` copies native RGB → `Bitmap` on `frameIndex` change. Fine for page swipe; **cannot** be a 30 fps player.

**Baseline.** Pump preview by copying `GetFrameRgbPtr` → Bitmap/`UIImage` every vsync (ImagePreview analog).

**Metrics (device).** Preview fps and jank while playing; CPU% / thermal; time for `ensureFrameAt(playhead)` during playback; extra RSS of the CPU sink.

**Gate.** Ship Surface path if 30 fps preview is stable and Bitmap-pump is not (dropped frames / >16 ms UI). Keep a CPU snapshot API for OCR. Reject a second **independent** always-on HW decoder if one decoder feeding Surface + `ImageReader` / `AVPlayerItemVideoOutput` meets both (measure both architectures).

Host RGB benches **cannot** decide this.

---

## 5. Y-plane as Gray8 (no RGB round-trip)

**What.** Decoded video is almost always NV12/YUV420. The **Y plane is luma**. Detectors that accept gray use Y directly (crop/scale in-tree; **libyuv if §11 wins**). RGB conversion only for color VLMs, and then into the hot window — never YUV→RGB on every Get.

**Why video-specific.** Image Gray8 is `RGB→Y` (extra pass, −67% RAM). Video Y is **already there**; RGB→gray would throw away a free plane and pay the convert tax measured on synthetic YUV (~28× on Get if you convert every time).

**Baseline.** Always convert to RGB8, then optional `RgbToGray`.

**Metrics.** Convert µs/frame; RSS of Y-only vs RGB; OCR quality on a gray det (character error / box recall) on Y vs RGB→gray vs full RGB.

**Gate.** Ship Y-direct if convert time is a large fraction of `Ensure` **and** gray OCR quality is not worse than RGB→gray. Keep RGB path for color VLMs. Reject if all target models require RGB and convert is cheap vs decode (then convert once into GOP RGB cache).

---

## 6. Thinning before decode (packet / frame-type skip)

**What.** Drop work **in the demuxer**, not after RGB exists:

- skip packets until the next sample PTS (e.g. 2 fps from 30 fps);
- **I-frame-only** mode for long-clip OCR;
- drop B-frames when OCR does not need interpolants.

**Why video-specific.** Stride on an RGB slab saves RAM, not decode. Decode is the expensive step.

**Baseline.** Decode every frame, then keep every 15th RGB (host `xor_stride_ocr` on eager RGB).

**Metrics.** Decoded-frame count, wall ms, RSS for: (a) 2 fps sample over 60 s, (b) I-only, (c) B-drop. Quality: OCR/VLM on 2 fps vs 30 fps vs I-only (expect diminishing returns).

**Gate.** Ship demux thinning if decode ms scales with **kept** frames (≪ 30 fps decode-all) and quality at 1–2 fps is acceptable for the product. Reject I-only if GOP is very long and scene changes between I-frames lose text.

---

## 7. Scrub pyramid vs analysis resolution

**What.** Two spatial/temporal qualities:

- **Scrub / timeline:** small I-frame thumbs (e.g. longest edge 160–320), `accuracy: 'keyframe'`.
- **Pause, OCR, VLM, still preview:** `maxSide` or full, `accuracy: 'accurate'`.

Finger moving → pyramid. Finger up → accurate + analysis res.

**Why video-specific.** Image `maxSide` is one raster per page. Video needs **cheap seeks under a moving slider** plus a sharp frame when the user stops. One full-res accurate seek per drag event will hitch.

**Baseline.** Every slider tick = accurate full-res decode. Alternate: one res for everything.

**Metrics.** Seek ms and decode px during a recorded scrub gesture; thumb atlas build time/RSS; OCR quality at analysis `maxSide` vs 160 px (must not use thumbs for OCR).

**Gate.** Ship pyramid if scrub p95 seek stays interactive (order of **one keyframe decode at thumb size**) and full-res-on-drag does not. Always keep analysis frames off the thumb path.

---

## 8. Sequential full-scan iterator (whole-video VLM / OCR)

**What.** Do not build a 30 fps RGB cube. Cursor API:

```
decodeRange({ startMs, endMs, strideMs, maxSide, format })
  → iterator of frame views (release each before next)
```

Plus `sampleFrames({ strategy: 'uniform' | 'fps' | 'keyframes' | 'scene', maxFrames, … })` for **one** native-video VLM call (typical T = 8–64).

Sticky decoder: keep the codec context, walk forward. Random `EnsureAt` is the other mode (§2–3).

**Why video-specific.** “Analyze the whole video” on device is a **stream**, not a loaded buffer. Native video VLMs still sample a handful of tensors; full OCR of a recording is sliding windows with optional overlap, then a timeline merge.

**Baseline.** Decode all frames to mmap RGB, then feed the model. Alternate: independent `EnsureAt` per sample (seeks).

**Metrics.** RSS peak vs duration (must be ~O(window), not O(duration)); ms/min of video; decode-frame count vs seek count (iterator should seek ~once per clip). VLM: T=8/16/32 quality vs cost.

**Gate.** Ship iterator as the full-analysis path if RSS stays flat as duration grows and seek count stays ~1. Ship `sampleFrames` if T≪ total frames with acceptable VLM quality. Reject eager RGB for anything longer than a short clip (already suggested by layout benches).

---

## 9. PTS timeline, VFR, display matrix, color range

**What.** Public time axis = **PTS / ms**, not `frameIndex`. Handle:

- variable frame rate;
- MP4 display matrix (90/270° phone video);
- limited vs full range (TV 16–235 vs JPEG 0–255);
- estimated `frameCount` only as a hint.

**Why video-specific.** Wrong rotation or range is not a micro-optimization, but it **is** video pipeline correctness that ImageBuffer solved via EXIF. Treating video as `frame[i]` like PDF pages will desync the player and OCR overlays.

**Baseline.** Assume CFR, identity rotation, full range, `index = round(t * fps)`.

**Metrics.** Functional: overlay boxes stay on text after rotate; playhead OCR matches visible frame; duration vs last PTS. Perf: rotation via libyuv vs decode-into-rotated; range convert cost (should be small vs decode).

**Gate.** **Ship the PTS/metadata path regardless of throughput** if fixtures show VFR/rotation/range errors on the baseline (quality gate). Perf variants (when to rotate, fused libyuv) only if convert ≥ a few ms/frame at 1080p.

---

## 10. Live ring of encoded packets or HW frames (not RGB)

**What.** Live capture ring holds **compressed GOP chunks** and/or `AHardwareBuffer` / `CVPixelBuffer`, not a ring of RGB8. RGB/YUV CPU copies exist only for the frame OCR is looking at. Backpressure: drop video frames if OCR lags (unlike typical audio).

**Why video-specific.** Image/Audio live rings of PCM/RGB bound RAM for low-rate stills. 1080p60 RGB is ~373 MiB/s; a 16-frame RGB ring is already ~50–80 MiB and still loses the encode. Encoded or HW-backed rings match real camera pipelines.

**Baseline.** Host `live_ring` RGB (16 frames). Device: `ImageReader` RGB copies every camera frame.

**Metrics.** RSS vs resolution/fps; dropped-frame count with a slow OCR stub; time from capture to `GetFrameRgbPtr` of “latest”; thermal over 60 s.

**Gate.** Ship encoded/HW ring if RGB ring RSS or copy time is unacceptable at target capture size (expect 1080p+). Keep a small CPU “latest frame” slot for OCR. Reject extra complexity for low-res / low-fps capture if RGB ring already meets RSS.

---

## Suggested test order

1. **§9 fixtures** (VFR, rotation, range) — correctness before speed.  
2. **§1 + §2 + §6** on **device** (MediaExtractor/AVAsset + HW decode) with a real 720p/1080p file — biggest “do we even decode everything?” questions. Host keeps synthetic GOPs only.  
3. **§3 + §8** — GOP cache vs sticky iterator (analysis).  
4. **§5** — Y vs RGB convert + one gray OCR quality check.  
5. **§11 libyuv** — same convert/scale/rotate microbench: in-tree vs libyuv (host + device).  
6. **§7 + §4 + §10** on device — player/scrub/live; host cannot sign off.

Do not use the existing RGB `videobuffer_bench` backings as accept/reject for §1–4, §6–8, §10.

---

## Decoder policy: one path, no fallback

**Policy.** One deterministic pipeline per platform. Unsupported file → `ERR_VIDEO_UNSUPPORTED` (or equivalent), **not** a second decoder. No HW-then-FFmpeg, no opt-in SW “just in case.” A fallback is another branch, another pixel/PTS flavor, and another test matrix.

**Not legal advice.** Copyright (LGPL) ≠ codec patents. Platform decoders sit on OEM licenses; shipping an extra SW H.264/HEVC in the `.so` is a separate patent surface we do not take on without a product need.

### Chosen stack: platform extractor + platform decoder

Same idea as HEIC today (Android `Bitmap` / iOS ImageIO): **one contract, OS implementation, no extra codec lib.**

```
VideoRegistry (C++ API / types)
  demux/index : MediaExtractor (Android) / AVAsset (iOS)   ← OS, not FFmpeg
  decode      : MediaCodec     (Android) / VideoToolbox     ← always, never SW alt
  convert     : in-tree C++ (YUV planes → RGB/Gray) until tests prove otherwise
  preview     : Surface / AVPlayer on the **same file**
```

FFmpeg stays **audio-only**. Do not enable `h264`/`hevc`/`swscale` in the prebuilt. Do not use `avformat` for video if MediaExtractor/AVAsset already own the file — two demuxers are a fallback in disguise (different index, different seek).

| Need | How, without a new library |
|------|----------------------------|
| Perf | HW decode **is** the large win vs any SW codec |
| File support | Phone files (H.264/HEVC MP4, often VP8/VP9/AV1 on Android) are what the OS already decodes. That set is **wider** in the wild than a minimal FFmpeg decoder list |
| Determinism | One color path, one PTS source, one seek implementation per OS |
| Host tests | GOP/cache/iterator logic with **synthetic** GOPs (already in `VideoRegistry`); real decode on device / iOS-sim VideoToolbox. Do not add FFmpeg-video to make Mac Android-like |

iOS vs Android glue is **not** a fallback: it is one behavior spec, two OS backends (ImageBuffer HEIC, fileio, etc.).

### When an extra library is allowed

Only if tests show **both**:

1. a large, stable perf gap on the hot path, **and**
2. file support the OS path cannot provide (codec/container the product must open),

**and** the lib **replaces** the in-tree piece, not sit beside it.

| Candidate | Adds formats? | Likely perf | Verdict under this policy |
|-----------|---------------|-------------|---------------------------|
| FFmpeg video SW | Only codecs we enable; misses device-only HW formats | **Worse** than MediaCodec/VT on device | **No.** Would exist only as fallback or as a slower single path |
| FFmpeg `h264_mediacodec` wrapper | No | Same HW, worse API | **No.** Native MediaCodec is the one path |
| **libyuv** | **No** | Often large on NV12→RGB / scale / rotate | **Test (§11).** Not a fallback: either keep in-tree or **replace** it. Ship only if the gate below hits. |
| dav1d / OpenH264 | AV1 / AVC SW | SW ≪ HW | **No** unless a required container has **no** OS decoder — then it becomes the only decode path for that format, not a fallback for H.264 |
| swscale | No | Convert only | **No** if FFmpeg video stays off |
| OpenCV, x264, second FFmpeg | — | — | **No** |

In-tree convert (the YUV helpers already in `VideoBuffer.cpp`) is the **starting** implementation: one call site, no dep.

### §11 libyuv test (active)

**Baseline.** In-tree `Yuv420ToRgb` / scale / rotate on NV12 from the HW decoder (or a packed YUV fixture on host).

**Variant.** Same call site linked to libyuv (`NV12ToRGB24`, `I420Scale`, `I420Rotate`). Not a runtime if/else.

**Metrics (1080p and 720p, 100 frames):** µs/frame convert; µs/frame scale 1080p→448; convert **share of** (decode + convert); RSS.

**Gate.** Replace in-tree with libyuv if convert is a **large, stable** fraction of the hot path (order of decode cost, or clearly several ms/frame at 1080p) **and** libyuv is clearly faster than in-tree. Otherwise keep in-tree — libyuv adds no codecs.

### Tests that remain (stack, not A/B codecs)

Not “HW vs FFmpeg.” Measure the **one** path:

- Seek p95 / keyframe index on MediaExtractor vs AVAsset (document differences; do not merge with a third indexer).
- §11 convert/scale as above.
- Surface preview vs Bitmap pump (§4) — still one decoder, two sinks.
- Unsupported codec: must fail cleanly, never silently succeed on another backend.

Host RGB `videobuffer_bench` still does not accept/reject this stack.

---

## Non-goals (unless a later test forces them)

- GPU texture atlases as the **OCR** backing (preview Surface is §4, not OCR storage).
- OpenCV `VideoCapture` as SOT.
- A second FFmpeg in-process (FFmpeg-Kit clash; see [`disable-ffmpeg.md`](../disable-ffmpeg.md)).
- `--enable-gpl`, libx264, libx265, or any GPL decode/encode in the FFmpeg prebuilt.
- FFmpeg video decoders / `swscale` as a **fallback** or parallel path next to MediaCodec/VideoToolbox.
- Using FFmpeg `avformat` **and** MediaExtractor/AVAsset on the same file (two indexes).
- HLS/DASH live streaming as the first VideoBuffer.
- Per-frame mmap `.rgb8` files (already rejected by layout benches).
