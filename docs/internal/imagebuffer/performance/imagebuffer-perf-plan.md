# ImageBuffer — performance analysis and bench plan

**Status:** measurement wave closed 2026-10-30. Product ranking: [`imagebuffer-android-ios-ranking.md`](./imagebuffer-android-ios-ranking.md). Throwaway harness stays on local `exp/imagebuffer-perf` (do not merge). This branch (`feat/imagebuffer-perf`) implements the keep set. No LiveImageBuffer (#16). No physical iOS device.  
**Clone:** `/Volumes/SSD/dev/react-native-sherpa-onnx-imagebuffer`  
**Base:** local `feat/add-videobuffer` from `/Volumes/SSD/dev/react-native-sherpa-onnx` (`8f43d2a9`).  
**Method:** same as VideoBuffer. Each candidate has a named baseline, host and/or device metrics, and a ship gate. After benches, fill the scoreboard with measured **× vs baseline**. Ship only rows that beat the gate.  
**Video analog:** [`docs/internal/videobuffer/performance/`](../../videobuffer/performance/). Do not copy video GOP/demux items.  
**Existing note:** [`docs/future-work/imagebuffer-perf-future-work.md`](../../../future-work/imagebuffer-perf-future-work.md) — this plan supersedes it as the SOT for *what to measure*. That file remains the short backlog of product ideas.

---

## 0. What is already shipped (do not re-invent)

| Item | Where | Role |
|------|--------|------|
| RAM vs mmap RGB backing, dynamic threshold | `ImageRegistry`, `ImageMmapThreshold` | Same numbers as OfflineAudioBuffer |
| Per-frame temp files `img_off_<uuid>_f<N>.rgb8` | `ImageRegistry::MmapFrame` | File-backed RGB, orphan sweep |
| Zero-copy OCR read | `GetFrameRgbPtr` | Engine reads RGB8 in-process |
| `maxSide` after decode (default 4096) | `ImageDecoder::ApplyMaxSide` | **Scalar bilinear** — a prime bench target, not a finished optimization |
| Decode progress / cancel | create-from-files | Correctness |
| PDF `lazy-lru` + `hotFrames` + `ensureFrame` | `CreateLazyPdfSlots` | Only PDF, not file JPEG/PNG |
| FrameView / AnnotatedView / export | Kotlin/iOS + `ImageFrameEncoder` | UI + write-out |
| WebP | opt-in libwebp | Already a native decoder when enabled |
| HEIC | Android `ImageDecoder` API 28+ / iOS ImageIO | Platform path → `AdoptRgbFrame` |

Correctness host tests exist (`test/cpp/imagebuffer/*`). Timed device benches: [`imagebuffer-device-bench-results.md`](./imagebuffer-device-bench-results.md).

---

## 1. Current hot path (why the list exists)

```
file / bytes
  → slurp entire file into RAM
  → stb_image (JPEG/PNG/BMP/GIF) or libwebp (WebP)
  → copy pixels into std::vector<uint8_t>   // second allocation
  → JPEG: scalar EXIF rotate/mirror
  → scalar bilinear ApplyMaxSide (full-res RGB → target)
  → ImageRegistry: RAM vector or one mmap file per frame
  → OCR: GetFrameRgbPtr → another scalar bilinear in PpocrImageOps / DoctrImageOps
```

Packed RGB8, **no row padding**, **no 64-byte alignment**. VideoBuffer later measured 34–108× on aligned slabs for YUV math; ImageBuffer never applied that lesson because libyuv is not in this branch.

`ApplyMaxSide` and OCR `ResizeRgb` are the same nested-loop bilinear. A win on libyuv scale should be wired once and reused.

File images are **eager**: `CreateFromFiles` decodes every path to RGB before return. Only PDF has lazy slots.

Live ImageBuffer is types-only (`liveImageBuffer` reserved). Out of scope for the first bench wave; sketched in §7 so pipeline naming stays compatible.

---

## 2. Scoreboard (fill after tests)

Literature × in the Hypothesis column is **not** a ship number. Replace with measured × on this SDK, these fixtures, this device class.

| # | Candidate | Hypothesis (literature / structure) | Host? | Device? | Result × | Ship? |
|---|-----------|--------------------------------------|-------|---------|----------|-------|
| 1 | **libyuv** RGB scale vs `ApplyMaxSide` | VideoBuffer convert/scale/rotate was 5–34× vs in-tree. Same library, RGB24 `Scale` / `ARGBScale`. | yes | yes | **0.33×** A142P 24MP→1024 (1080p 0.71×) | **no** (gate ≥ 3×) |
| 2 | **libyuv** EXIF rotate/mirror vs scalar | Same as (1), `Rotate` / `I420Rotate` or RGB rotate. | yes | yes | **0.54×** 24MP | **no** (gate ≥ 3×) |
| 3 | **libjpeg-turbo** vs stb JPEG | ARM64 1.4–4.7× RGB, ~1.4–6.4× gray; ~30% less peak RAM ([libphash 2026-10](https://gudoshnikovn.github.io/libphash/benchmarks/2026-10-04-decoders-vs-stb/)). | yes | yes | **0.56×** 24MP (3.3 MB JPEG); 1080p 0.44× | **no** |
| 4 | JPEG **DCT / IDCT scale** (1/2, 1/4, 1/8) then fine scale | Firefox: ~1.8–2.4× CPU and 3–20× less intermediate RAM vs full decode + Lanczos. | yes | yes | **2.99×** A142P / **3.04×** iOS sim (`idctDenom=4`) | **no** — turbo skipped; IDCT is turbo-only |
| 5 | Decode **into dest buffer** (no stbi + `assign`) | Cuts one full-frame copy + peak. Expect ~1.1–1.3× and lower RSS. | yes | later | — | not measured |
| 6 | **64-byte aligned** RGB rows | Needed if (1) wins; VideoBuffer aligned RAM 34–108× was for YUV SIMD. RGB scale needs stride. | yes | yes | **0.99×** 24MP | **no** |
| 7 | **One mmap slab** vs per-frame `.rgb8` files | VideoBuffer kept one region. Image today: N files, N `mmap`. Open/evict cost. | yes | yes | **1.00×** 24MP (2 pages) | **no** |
| 8 | **Compressed retain + lazy decode** (files) | PDF lazy already. File JPEG kept as bytes; RGB on `ensure` / OCR. RSS ≈ files not full RGB. | yes | yes | 24MP 8 files: +ensure0 **7.4×** A142P / **7.9×** sim | **yes (latency)**; process RSS not isolated |
| 9 | **Wuffs** (or libspng) vs stb PNG | Wuffs PNG 1.2–2.7× vs libpng; stb often similar to libpng. | yes | yes | **0.49×** 24MP photo PNG | **no** |
| 10 | **Gray8** backing | ~3× less RAM; extra RGB→Y pass. Only if a detector accepts gray **and** quality holds. ppocr/doctr/VLM today take RGB8. | yes | OCR quality | — | not measured |
| 11 | Share scale path with **OCR ImageOps** | Same bilinear twice per page (buffer `maxSide` + det resize). | yes | OCR e2e | — | skip while #1 loses |
| 12 | **Parallel** multi-file create | Decode N JPEGs on a pool. Wall time ~1/N until RAM/IO bound. | yes | yes | **1.59×** A142P 4 files; **2.16×** iOS sim | **no** on device (gate ≥ 2×) |
| 13 | JPEG **region / crop** (`jpeg_skip_scanlines` + crop) | Tile mega-scans without full RGB. | yes | later | — | not measured |
| 14 | **libjpeg-turbo encode** vs stb_write | Export path only. | yes | yes | **0.42×** 24MP | **no** |
| 15 | Platform **HW decode** (Bitmap / ImageIO) vs portable C++ | Device-only. Host tests cannot accept/reject. | no | **yes** | **10.1×** A142P `ImageDecoder` (24MP); iOS sim ImageIO RGB8 **0.80×** (~20 % slower) | **no** — not shipping an Android-only JPEG path; HEIC stays platform on both |
| 16 | **Live ImageBuffer** ring | Pipeline completeness. **No prio.** See §7. | later | later | — | later |

Device extras (not numbered): libwebp `use_scaling` **5.05×** A142P 24MP / **4.42×** iOS sim — **yes**, already in the SDK (1080p was 6.65× / 6.95×). Full table: [`imagebuffer-device-bench-results.md`](./imagebuffer-device-bench-results.md). Ranking fixture is 24MP phone JPEG; 1080p gradient is appendix. iOS sim is **not** a device ranking.

**No new OSS library ships.** libyuv, libjpeg-turbo, and Wuffs all miss their gates on 24MP (except turbo IDCT, which is dropped with turbo). Default remains Baseline stb + scalar. Product keep set: file-image **lazy** (#8) and WebP **`use_scaling`**.

Skipped unless a later product demand appears: OpenCV as I/O, libheif as default HEIC, GPU texture atlases, JPEG-XL, QOI.

---

## 3. External C++ libraries (libyuv analog)

VideoBuffer’s measured win was **libyuv** (BSD-3 + Google `PATENTS`) for convert/scale/rotate. ImageBuffer has no YUV GOP; the equivalent SIMD surface is **decode** (JPEG/PNG) and **RGB scale/rotate**.

### 3.1 Measure first (likely keep)

| Library | License | Replaces | What to bench | Notes |
|---------|---------|----------|---------------|--------|
| **libyuv** | BSD-3 + PATENTS | `ApplyMaxSide`, EXIF rotate, later OCR `ResizeRgb` | RGB24/ARGB scale + rotate vs current scalar loops | Already the VideoBuffer choice. Not in *this* branch yet; vendor the same pin if (1)/(2) win. RGB24 in libyuv is BGR; VideoBuffer already wraps RAW vs RGB24. |
| **libjpeg-turbo** | IJG + BSD-3 | stb JPEG decode (and optionally encode) | Full-res decode; decode-at-`maxSide` via `scale_num`/`scale_denom` | NEON on arm64. SIMD-accelerated IDCT scale is 1/2 and 1/4 (plus 1/8). Arbitrary `maxSide` = IDCT step + libyuv fine scale. MIT-compatible. |

### 3.2 Measure, weaker or format-specific

| Library | License | Replaces | Notes |
|---------|---------|----------|--------|
| **Wuffs** (transpiled C) | MIT **or** Apache-2.0 (dual since 2023) | stb PNG (GIF too) | Memory-safe; PNG often 1.5–2.7× vs libpng. JPEG exists in Wuffs but turbo is the usual mobile JPEG winner — bench both if JPEG work starts. Extra codegen/build story vs a single `.c`. Vendor a current dual-licensed release and take **MIT**. |
| **libspng** | BSD-2 | stb PNG | Smaller than libpng; usually not faster than Wuffs on ARM. |
| **libpng + zlib-ng** | libpng + zlib | stb PNG | Photographic PNG 1.25–1.7× vs stb in one Linux bench; screenshots often a tie. Heavier than libspng. |
| **libwebp** | BSD | already used | Keep. Bench `WebPGetInfo` + scaled decode (`WebPDecoderConfig.use_scaling`) vs full `WebPDecodeRGB` + `ApplyMaxSide`. |
| **stb_image_resize2** | public domain | `ApplyMaxSide` only | Better filter than our loop, still not NEON libyuv. Only interesting if libyuv is rejected. |

### 3.3 Do not start with

| Library | Why not (until a gate says otherwise) |
|---------|----------------------------------------|
| **OpenCV** | Already a non-goal in the future-work note. Huge, I/O is not the reason to ship it. |
| **Leptonica** | OCR toolkit, not a JPEG decoder. |
| **libheif / libde265** | HEIC already has a platform path. Software HEIC is a separate epic. |
| **mozjpeg** | Encoder-focused; turbo covers decode. |
| **libjxl / AVIF** | Not a current create-API format. |
| **Google Highway** | SIMD toolkit; libyuv already has the kernels we need. |

### 3.4 Platform (device benches only)

| API | Role |
|-----|------|
| Android `BitmapFactory.inSampleSize` / `ImageDecoder` | Power-of-two subsample close to JPEG IDCT scale. Not host-testable. |
| iOS ImageIO + **vImage** (Accelerate) | HW/SIMD scale. Compare to libyuv on device, do not make it the only path (host tests + Android). |

Portable C++ (turbo + libyuv) stays the SOT so `videobuffer_core`-style host tests remain possible.

---

## 4. Candidate details (baseline / metrics / gate)

### 4.1 libyuv scale (#1) — likely largest cheap win

**What.** Replace the pixel loops in `ImageDecoder::ApplyMaxSide` with libyuv (`ARGBScale` or RAW scale, filter `kFilterBox` or `kFilterBilinear`).

**Baseline.** Current `ApplyMaxSide` on a decoded 4032×3024 JPEG down to `maxSide=1024` and `4096`.

**Metrics.** ms/frame, MP/s, output checksum vs bilinear (PSNR / max abs err). Peak RSS.

**Gate.** Ship if ≥ **3×** vs scalar on 8 MP→1024 (host arm64 or x64) and PSNR stays in a band that does not move OCR boxes (spot-check ppocr on 2 pages). Reject if ~1× (then the bottleneck is decode, not scale).

### 4.2 libyuv EXIF rotate (#2)

**What.** Orientations 2–8 via libyuv rotate/mirror instead of `SetPixel`/`GetPixel`.

**Baseline.** Current `ApplyExifOrientation` on a 12 MP JPEG with orientation 6 (90°).

**Gate.** Ship if ≥ **3×** and pixels match (exact, rotate is lossless in 90° steps).

### 4.3 libjpeg-turbo (#3)

**What.** JPEG branch of `DecodeBytes` → turbo. PNG/GIF/BMP stay stb until #9.

**Baseline.** stb `stbi_load_from_memory(..., 3)` on the same bytes.

**Fixtures.** Progressive vs baseline; 1 MP / 8 MP / 12–20 MP phone photos; gray vs 4:2:0 color.

**Gate.** Ship if ≥ **1.5×** decode on 8 MP arm64 **or** peak RSS drops ≥ 20% at equal time. Reject if only x64 wins.

### 4.4 JPEG decode-at-scale (#4)

**What.** If `maxSide` is set, pick the largest turbo IDCT factor in {1, 1/2, 1/4, 1/8} that stays ≥ target, then libyuv to exact `maxSide`.

**Baseline.** Full-res turbo (or stb) decode + `ApplyMaxSide`.

**Gate.** Ship if wall time **and** peak RSS beat full-res+scale on 12 MP→1024 (expect RSS drop larger than time drop). Reject if artifacts show on MCU-padded JPEGs (known turbo IDCT-scale issue) — then limit to 1/2 or disable when dimensions are not MCU-aligned.

### 4.5 Decode into destination (#5)

**What.** `stbi_load_from_memory` already allocates; we `assign` again. Turbo can write into a pre-sized aligned buffer.

**Baseline.** Current two-allocation path.

**Gate.** Ship with #3 if extra copy is ≥ 10% of decode time or shows up in peak RSS. Otherwise fold into turbo work and do not advertise as its own feature.

### 4.6 Alignment + slab (#6, #7)

**What.** Row stride rounded to 64 bytes; optional one `mmap` region for all hot frames (VideoBuffer `FrameSlab`).

**Baseline.** Packed RGB8; one file per mmap frame.

**Gate.** Alignment: ship if #1’s libyuv scale is ≥ 1.2× faster on aligned vs packed (otherwise keep packed for OCR pointer simplicity). Slab: ship if create/ensure of a 30-frame buffer is faster or RSS/fd count is materially better; reject if OCR `GetFrameRgbPtr` simplicity regresses.

**OCR contract.** Today `GetFrameRgbPtr` implies packed 3×width. A padded stride is an **API change** (width, height, stride). Allowed (SDK unpublished) but must go through OCR backends in the same change.

### 4.7 Compressed retain + lazy file decode (#8)

**What.** `createFromFiles` stores paths/bytes (and format), `state: 'lazy'`, RGB on `EnsureFrame` / first `GetFrameRgbPtr` / FrameView. LRU like PDF `hotFrames`.

**Baseline.** Today’s eager decode-all.

**Metrics.** RSS after create (30× 8 MP JPEGs); time-to-first-ensure; time-to-OCR-all-pages; decode-count when the UI only shows page 1.

**Gate.** Ship if create RSS stays on the order of **compressed bytes**, not 30× RGB, and first-page time ≤ eager first-page (no large regression). Reject if every caller immediately ensures all frames (then lazy only adds complexity).

### 4.8 PNG decoder (#9)

**What.** Wuffs or libspng for PNG only.

**Baseline.** stb PNG.

**Gate.** Ship if ≥ **1.5×** on photographic PNG ≥ 4 MP. Reject if documents are almost all JPEG (measure fixture mix in the example OCR set).

### 4.9 Gray8 (#10)

**What.** Optional `pixelFormat: 'gray8' | 'rgb8'`.

**Baseline.** RGB8.

**Gate.** Ship only if (a) at least one production detector runs on gray without a quality drop vs RGB→gray, and (b) RSS drops ~3× on multi-page. **Do not ship** as default while ppocr/doctr/VLM copy RGB into NCHW.

### 4.10 OCR ImageOps share (#11)

**What.** Det/rec resize and warp call the same libyuv helpers as the buffer.

**Baseline.** `PpocrImageOps::ResizeRgb` / doctr equivalent.

**Gate.** Ship if OCR **e2e** (not just resize µs) drops ≥ 5% on a 3-page invoice, or if it is a zero-cost follow-on of #1. Quality: box IoU / text match vs current bilinear.

### 4.11 Parallel create (#12)

**What.** Thread pool over independent files. Respect cancel.

**Baseline.** Serial `CreateFromFiles`.

**Gate.** Ship if 8 files on a mid phone are ≥ **2×** wall-clock without inflating peak RSS beyond ~2× (decode two at a time if needed).

### 4.12 Region decode (#13)

**What.** turbo `jpeg_skip_scanlines` / `jpeg_crop_scanline` for tiles.

**Baseline.** Full decode + crop in RGB.

**Gate.** Only if OCR tiling (# future-work) is scheduled. Do not build tiles “just in case.”

### 4.13 Export encode (#14)

**What.** turbo JPEG encode vs `stbi_write_jpg`.

**Gate.** Ship if export of a 8 MP frame is ≥ **2×**. Low product priority vs create+OCR.

### 4.14 Platform HW decode (#15)

**What.** Android `ImageDecoder` / iOS ImageIO for JPEG too, not only HEIC.

**Baseline.** Portable turbo/stb on the same file.

**Gate.** Device-only. Ship as an **optional** fast path if ≥ **1.5×** and pixels match within a tight error (HW YCbCr conversion differs). Keep C++ path for host tests and for when the platform decoder fails.

---

## 5. How to run benches (same principle as VideoBuffer)

Throwaway example screen lived on `exp/imagebuffer-perf` only. Product work on this branch follows VideoBuffer:

1. **Host C++ first** (Google Benchmark or a small timed harness next to `test/cpp/imagebuffer/`). Fixtures: phone JPEG 1/8/12 MP, PNG screenshot, PNG photo, WebP, JPEG with EXIF 6, synthetic 64×48 (correctness only).
2. Report **p50/p95 ms, MP/s, peak RSS, extra copies**. Always vs a **named baseline binary** (current stb + scalar), same compiler flags.
3. Fill §2 Result ×. Literature numbers stay in Hypothesis.
4. **Device second** (Android first, logcat tags): `createFromFiles` 20-camera roll, FrameView swipe, ppocr `recognize` 3 pages. iOS after Android isolates the cause (workspace rule).
5. Implementation of a winner is a later epic, one candidate at a time, logs on, no speculative multi-path.

Suggested host suites (names for the later harness, not built now):

| Suite | Exercises |
|-------|-----------|
| `decode_jpeg_stb_vs_turbo` | #3 |
| `decode_jpeg_full_then_scale_vs_idct` | #4 |
| `scale_scalar_vs_libyuv` | #1 |
| `exif_scalar_vs_libyuv` | #2 |
| `png_stb_vs_wuffs` | #9 |
| `webp_full_vs_scaled` | libwebp `use_scaling` |
| `eager_vs_lazy_30page` | #8 |
| `packed_vs_aligned_stride` | #6 |
| `mmap_per_frame_vs_slab` | #7 |
| `serial_vs_parallel_create` | #12 |

---

## 6. Suggested measure order

1. **#1 libyuv scale** — one dependency, touches the known scalar loop, host-only, informs #6.  
2. **#3 turbo JPEG** — most real input is JPEG.  
3. **#4 IDCT scale** — only if #3 ships; needs turbo.  
4. **#2 rotate** — cheap follow-on of #1.  
5. **#8 lazy file retain** — product-visible RAM for documents; more API work.  
6. **#11 OCR ops** — after #1 exists.  
7. **#9 PNG** — if traces show PNG time.  
8. **#12 parallel** — after decode is not the serial bottleneck.  
9. **#15 platform HW** — device wave.  
10. **#10 Gray8 / #13 tiles / #14 export / #7 slab** — only with a failing metric.

---

## 7. Live ImageBuffer (deferred, no prio)

Pipeline compatibility: audio/video have `offline*` + `live*`. Image should grow `LiveImageBuffer` with `recording → finished` (CAS, never back) so camera / streaming OCR can use the same `recognize` / FrameView contracts on a finished live handle.

**Not in the first bench wave.** When it is:

| Idea | Baseline to beat |
|------|------------------|
| Ring of last N **compressed** frames (JPEG/WebP) | Ring of last N RGB8 (will OOM at 1080p×30) |
| Optional spool of compressed chunks | Ring-only (drops under backpressure) |
| Backpressure: drop vs block when OCR lags | Unbounded queue |
| Finalize → mmap `OfflineImageBuffer` | Copy-all RGB |

Camera ingest is platform (ImageReader / AVFoundation). Host tests can fake compressed packets. Align naming with LiveAudioBuffer / LiveVideoBuffer; pixel format is not PCM.

---

## 8. Constraints

- SDK MIT. No GPL (`--enable-gpl`, OpenCV GPL modules, libx264, etc.). See §8.1.  
- Host tests must not require a device. HW JPEG is extra, not the only path.  
- Fix at the lowest correct layer (decoder/scale in C++ `image/`, not a TS workaround).  
- OCR quality is a gate whenever pixels change (scale filter, IDCT scale, gray).  
- This branch does not contain VideoBuffer/libyuv yet. If ImageBuffer vendors libyuv first, pin the same revision VideoBuffer used (libyuv `1976` prebuilts exist on the GitHub tags).

### 8.1 License check (commercial use)

SDK license is MIT (`LICENSE`). Apps that embed the SDK may sell, close-source, and ship on App Store / Play. Third-party code must stay **permissive** (MIT / BSD / Apache-2.0 / zlib / IJG / PD). **No GPL, LGPL-as-the-only-path, or `--enable-gpl`.** (FFmpeg in this repo is already LGPL-2.1+ without GPL flags; ImageBuffer must not pull a GPL decoder.)

Checked 2026-10-30 against upstream LICENSE files. Not legal advice; if a row ships, copy LICENSE (+ PATENTS where present) into `third_party/` and `THIRD_PARTY_LICENSES/` as with libyuv / libwebp.

| Library | SPDX / text | Commercial? | Fit in MIT SDK | Practical extra |
|---------|-------------|-------------|----------------|-----------------|
| **libyuv** | BSD-3-Clause + Google `PATENTS` | yes | yes — already vendored in VideoBuffer | Ship `LICENSE` + `PATENTS`. Patent grant **terminates** if you sue over libyuv (same clause as WebM). |
| **libjpeg-turbo** | IJG + BSD-3-Clause | yes — IJG explicitly welcomes commercial products, no royalty | yes | If statically linked: docs must say *“This software is based in part on the work of the Independent JPEG Group.”* Keep `README.ijg`. Vendor the **libjpeg API**, not `cjpeg`/`djpeg` (those also pull libspng). Do not use the IJG / project name in ads. |
| **Wuffs** | dual **MIT or Apache-2.0** (since 2023-10) | yes | yes — pick **MIT** to match the SDK | Do **not** pin frozen `wuffs-v0.2.c` / `v0.3.c` (Apache-2.0 only). Use a current dual-licensed release / `wuffs-mirror-release-c`. |
| **libspng** | BSD-2-Clause; `spng.c` also libpng-2.0 | yes | yes | Keep both notices if that file is vendored. |
| **libpng** | PNG Reference Library License 2 | yes (“any purpose, without fee”) | yes | Weaker candidate; license is fine. |
| **zlib-ng** | zlib | yes (“including commercial applications”) | yes | Only if libpng is chosen. |
| **libwebp** | BSD-3-Clause + WebM `PATENTS` | yes | yes — **already shipped** (opt-in) | Same defensive patent-termination as libyuv. |
| **stb_image** / **stb_image_resize2** | public domain / MIT | yes | yes — stb_image **already shipped** | Keep `STB_IMAGE_LICENSE.txt`. |
| Android `ImageDecoder` / iOS ImageIO / vImage | platform SDK | yes in apps | n/a — not redistributed | Device fast-path only; no extra OSS license. |

**Rejected on license (unchanged):** OpenCV GPL modules, libx264, FFmpeg `--enable-gpl` / `--enable-nonfree` / `--enable-version3`, anything AGPL.

Apache-2.0 alone would also be commercially usable (PaddleOCR weights in this repo already are). Dual-MIT Wuffs is simpler: no NOTICE file, same terms as the SDK.

---

## 9. Out of this phase

- Live buffer implementation (#16).  
- Physical iOS device benches (sim ImageIO RGB8 is 0.80× on 24MP).  
- Throwaway harness / vendored measurement libs: local `exp/imagebuffer-perf` only.  
- 24MP JSON: [`imagebuffer-bench-android-24mp/`](./imagebuffer-bench-android-24mp/), [`imagebuffer-bench-ios-sim-24mp/`](./imagebuffer-bench-ios-sim-24mp/).

Harness JSON pull (harness branch):

```
adb logcat -d -s ImageBufferBench:I
adb exec-out run-as com.xdcobra.voicelab cat files/imagebuffer-bench-all.json
adb exec-out run-as com.xdcobra.voicelab cat files/imagebuffer-bench.ndjson

xcrun simctl get_app_container <UDID> com.xdcobra.voiceexample data
# Documents/imagebuffer-bench-all.json
```
