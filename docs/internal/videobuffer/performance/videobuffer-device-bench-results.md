# VideoBuffer device benches (Nothing A142P, SDK 36)

Cross-platform ranking (canvas): [videobuffer-android-ios-ranking.md](./videobuffer-android-ios-ranking.md).

Isolated suites, force-stop between. Fixture: H.264 640×360 30 fps 6 s GOP30. 2026-10-29.

All 14 suites present, no errors.

## 1080p isolated rerun (2026-10-29, 11:49–12:04)

Fixture `bench_h264_1080p.mp4` (1920×1080 High, 30 s, 900 frames). 13/14 suites wrote JSON. **retain crashed** before emit — `all.json` still has the 360p retain row.

`java.lang.OutOfMemoryError` at `retainBench` line 154 (`ByteArray(1920*1080*3)`). Java heap growth limit **256 MB**. One 1080p RGB frame is 6.2 MB; 90-frame eager hold is 560 MB. Layout survived 30-frame RGB (187 MB). Crash is the retain result: eager RGB hold is impossible at 1080p, not just slow.

| Item | 1080p vs 360p | Keep? |
|---|---|---|
| libyuv | I420 54.6 vs 1282 (**23.5×**); scale 11.2 vs 55.5 (**5.0×**); rot90 39 vs 413 (**10.5×**) | yes |
| aligned / slab | ingest 34 vs 1303; slab 215 vs per-frame 491 | yes |
| convert-on-Get | yuv420 xor_window 7.9 s vs RGB ptr 0.02 ms | no |
| decode | **10.6 ms/frame** (3.8× 360p, not 9×) | HW still cheap vs convert |
| seek keyframe / accurate | 101 vs 198 ms/seek (**2.0×**) | yes |
| index scan vs table | **4455 vs 93 ms/seek (48×)**; scan 36 s wall | never scan |
| GOP cache | 361 vs 1139 (**3.2×**) | yes |
| dual_sink | ImageReader 927 vs ByteBuffer 910 (**+1.8%**) | **still no default at 1080p** |
| Y vs RGB | 2.08 vs 9.12 ms/frame (**4.4×**) | yes Gray8 |
| thinning | all 909 / 2fps 635 / I-only 347 | yes |
| pyramid | 49 vs 254 ms/tick (**5.2×**) | yes |
| iterator | 904 vs 3131 (**3.5×**) | yes |
| PTS / matrix | 900 samples, 30 sync, rot90 → 270 | yes |
| live ring | 182 KB encoded vs 99.5 MB RGB (**546×**) | yes |
| retain eager RGB | **OOM / process death** | never eager hold |

## iOS Simulator 1080p (iPhone 17 / iOS 27, 16:39–16:50)

Isolated suites, process kill between. Fixture `bench_h264_1080p.mp4` (1920×1080 High, 30 s). **14/14 wrote JSON, no crash, no `error` field.** Raw: [videobuffer-bench-ios-sim-1080p/](./videobuffer-bench-ios-sim-1080p/). Simulator is not A12/A18 HW ranking — use for API shape + CPU convert/layout; re-check seek/decode/dual_sink on a real device.

| Item | iOS sim 1080p | Keep? |
|---|---|---|
| libyuv | I420 11.3 vs 370 (**33×**); scale 2.4 vs 20 (**8.4×**); rot90 6.8 vs 117 (**17×**) | yes — same as Android |
| aligned / slab | aligned ingest 6.1 vs ram_rgb 655 (**108×**); slab 15 vs per-frame 174 | yes |
| convert-on-Get | yuv420 xor_window 2431 vs RGB 117 | no |
| Gray8 | ingest 93 ms / 59 MB vs RGB 655 / 178 MB | yes |
| decode | **12.5 ms/frame** AVFoundation sequential (90 f) | HW still cheap vs convert; sim ≠ device |
| seek keyframe / accurate | 36 vs 28 ms/seek — **accurate faster** | **do not rank from sim** |
| index scan vs table | **1118 vs 8.8 ms/seek (127×)**; scan 8.9 s wall | never scan |
| GOP cache | 96 vs 9.2 (**10×**) | yes |
| dual_sink | alwaysCopies=NO 3.17 vs YES+Y 3.02 (**−4.5%**) | **still no default at 1080p** |
| Y vs RGB | yuv copy 5.7 vs RGB replicate 13.9 (**2.4×**) | yes Gray8 |
| thinning | all 243 / iOnly 191; **2fps 1954 (slower)** | iOnly ok; 2fps harness/seek on sim is not a win |
| pyramid | keyframe 37.7 vs accurate 39.2 (**+4%**) | **do not rank from sim** |
| iterator | sticky 217 (1 seek) vs independent 445 (12 seeks) (**2.1×**) | yes |
| PTS / matrix | 34 sync, CFR 30 s, rot90 → 270 | yes |
| live ring | RGB 16 f = 99.5 MB; encoded bytes **0 in harness** | yes conceptually; encoded size not measured on iOS |
| retain eager RGB | **succeeded** 280 ms / 90 f (sim RAM) | Android OOM still stands for device |

## iOS Simulator 360p (iPhone 17 / iOS 27, 16:52–17:00)

Isolated suites, process kill between. Fixture `bench_h264.mp4` (640×360, 6 s GOP30). **14/14 wrote JSON, no crash, no `error` field.** Raw: [videobuffer-bench-ios-sim-360p/](./videobuffer-bench-ios-sim-360p/). Same sim caveats as 1080p: rank CPU convert/layout/index; do not rank seek/pyramid/dual_sink vs a real iPhone.

| Item | iOS sim 360p | vs iOS sim 1080p | Keep? |
|---|---|---|---|
| libyuv | I420 2.36 vs 81 (**34×**); scale 3.2 vs 33 (**10×**); rot90 1.67 vs 23 (**14×**) | I420 2.4 vs 11.3 (pixels 9×, time **4.8×**) | yes |
| aligned / slab | aligned ingest 1.87 vs ram_rgb 144 (**77×**); slab 3.2 vs per-frame 31 | aligned 1.9 vs 6.1; slab 3.2 vs 15 | yes |
| convert-on-Get | yuv420 xor_window 306 vs RGB 15 | 306 vs 2431 | no |
| Gray8 | ingest 21 ms / 14 MB vs RGB 144 / 42 MB | 21 / 14 vs 93 / 59 | yes |
| decode | **0.75 ms/frame** (90 f) | 0.75 vs 12.5 (**17×**, not 9×) | HW cheap; sim ≠ device |
| seek keyframe / accurate | 10.1 vs 3.3 ms/seek — **accurate faster** | 10 vs 36 | **do not rank from sim** |
| index scan vs table | **33 vs 2.0 ms/seek (17×)**; scan 265 ms wall; 10 sync | 33 vs 1118 | never scan |
| GOP cache | 253 vs 212 (**1.2×**) | 1.2× vs 10× at 1080p — sim overhead | yes in principle; weak at 360p sim |
| dual_sink | alwaysCopies=NO 1.12 vs YES+Y 0.48 (**2.3× slower**) | 1.12 vs 3.17 | **no default** |
| Y vs RGB | yuv copy 0.56 vs RGB replicate 1.37 (**2.4×**) | same ratio as 1080p | yes Gray8 |
| thinning | all 68 / 90 f; 2fps 39 / 12 f; iOnly 21 / 90 f | 2fps wins at 360p (lost at 1080p) | I-only still reports 90 f (harness) |
| pyramid | keyframe 6.89 vs accurate 6.63 | 6.9 vs 38 | **do not rank from sim** |
| iterator | sticky 105 (90 f / 1 seek) vs independent 64 (12 f / 12 seeks) | independent “wins” only because 12 vs 90 frames | yes sequential; this row is not equal work |
| PTS / matrix | 10 sync, CFR 6 s, rot90 → 270 | 10 vs 34 sync | yes |
| live ring | RGB 16 f = 11.1 MB; encoded bytes **0 in harness** | 11 vs 99.5 MB RGB | iOS live encoded size unmeasured; **§10b policy = Android** |
| retain eager RGB | 200 ms / 90 f, file 664 KB | 200 vs 280 ms | sim RAM; Android 1080p OOM still stands |

## Cross-platform (Android device × iOS sim, 360p + 1080p)

iOS is **simulator**, Android is **Nothing A142P**. Rank ratios, not ms.

**Keep on both:** libyuv (I420 23–34×), aligned RAM (34–108×), mmap slab not per-frame, I-table never scan (17–127×), Gray8 when RGB unused, PTS + matrix 270°, GOP cache, sequential iterator, encoded live ring (iOS assumed equal to Android §10b; no camera / no sim HW-encode).

**Skip on both:** in-tree I420, per-frame mmap, convert-on-Get, dual-sink as default, eager RGB hold (Android 1080p OOM is the device truth; iOS sim success is RAM).

**Android device keep, iOS sim inverted — do not flip from sim:** keyframe vs accurate seek, keyframe pyramid, 2 fps thinning at 1080p. Re-bench those three on a real iPhone.

**No iOS-keep / Android-skip candidate.** Larger iOS CPU ratios are Apple Silicon, same policy.

## Public API shape (decided 2026-10-29)

One C++ core, two public kinds, same rules as audio (`offlinePcmBuffer` / `livePcmBuffer`):

- **`OfflineVideoBuffer`** — file-backed, `immutable`, random access through the I-frame table. The container is the encoded store (mmap); no encoded ring.
- **`LiveVideoBuffer`** — `recording → finished`, branded recording / finished handles. While recording: bounded ring + spool. After `finished` it accepts every Offline API, like `LiveBufferHandleFinished`.
- Shared core: libyuv, aligned RAM, one slab, YUV / Gray8 storage, decoded-frame LRU, GOP window, sequential iterator, PTS + matrix.

Why not one `VideoBuffer`: stages need to know at compile time whether they may seek back and whether the end is known (scrub, index, pyramid, full-video OCR vs live OCR).

Live ring content (**decided 2026-10-29, A142P 1080p `live_capture`**): **encoded HW H.264**, not raw YUV/Gray8. Decoder→encoder Surface (camera analog) added **6.93 ms/frame** on `c2.mtk.avc.encoder` (21% of the 33 ms budget), **0 dropped**, first packet 81 ms, **2.6 MB** resident vs Gray8 **124 MB** / YUV **187 MB**. Random Get from the encoded ring is **171 ms** (GOP decode, 12 packets) — use sequential iterator + decoded LRU for live OCR, not independent Gets. Raw Gray8 copy is the same CPU (~6.9 ms/frame) and loses on RAM. Eviction kept ~3 s not 2 s (`evictedGops: 0`); that does not change the ranking. Raw: [videobuffer-bench-android-live-capture-1080p/](./videobuffer-bench-android-live-capture-1080p/). **iOS: same policy as Android** (no camera, no iOS-sim HW-encode ranking). VideoToolbox encode is the iOS analog of MediaCodec Surface encode; do not add a `live_capture` iOS suite.

## Verdict




| Item | Keep? | Device evidence |
|---|---|---|
| §11 libyuv convert | **yes — replace in-tree** | I420ToRGB24 10.0 vs 234 ms (**23×**); scale 10.9 vs 91 (**8×**); rotate90 5.2 vs 73 (**14×**) |
| Slab mmap, not per-frame | **yes** | ingest 50 vs 190 ms; warm xor tied with RAM |
| Aligned RAM alloc | **yes** | ingest 8.4 vs 283 ms (`ram_rgb`) |
| Lazy LRU | **yes (RAM)** | 5.5 MB vs 41.5 MB RGB; access slower if convert-on-get |
| Convert YUV→RGB on every Get | **no** | `yuv420` ptr_seq 237 ms vs RGB ptr 0.04 ms |
| Gray8 / Y-plane | **yes when RGB unused** | layout Gray ~⅓ RGB bytes; yplane RGB expand 2.0 vs copy 0.41 ms/frame |
| §1 mmap container, no eager RGB | **yes** | mmap 1.3 ms / +1 MB PSS vs eager 283 ms / +36 MB |
| §2 extractor / I-table, not scan | **yes** | 21 vs 355 ms/seek (**17×**). Table ≈ extractor |
| §2 keyframe vs accurate | **yes (scrub vs Get)** | 23 vs 75 ms/seek (**3.2×**) |
| §3 GOP window cache | **yes** | 144 vs 482 ms (**3.4×**) |
| §4 dual sink Surface | **no default at 360p** | ImageReader PRIVATE 301 vs ByteBuffer 273 ms |
| §5 Y-plane vs RGB | **yes Gray8 path** | RGB replicate 4.8× slower than YUV copy |
| §6 demux thinning | **yes if OCR/VLM ≠ 30 fps** | all 251 ms / 90 f; 2 fps 87 ms / 12 f; I-only 79 ms / 6 f |
| §7 keyframe scrub pyramid | **yes** | 23 vs 85 ms/tick (**3.6×**) |
| §8 sequential iterator | **yes** | 234 vs 1188 ms (**5.1×**) |
| §9 PTS / matrix | **yes** | CFR 33333 µs; rot90 fixture → `KEY_ROTATION=270` (honor matrix) |
| §10 encoded live ring | **yes — HW encode, not raw** | demux 182 KB vs 99.5 MB RGB; **§10b** Surface encode 6.9 ms/frame, 0 drop, 2.6 MB vs Gray8 124 MB / YUV 187 MB |

## HW decode baseline

Sequential MediaCodec: **2.77 ms/frame** (90 frames, 249 ms). 360p decode is cheap; the wins are RAM, convert, seek policy, and not re-decoding GOPs.

## Do not ship

- Per-frame mmap files
- Naive in-tree I420→RGB / scale / rotate
- Linear scan-from-start for `ensureAt`
- Independent accurate seeks for sequential walks
- Eager RGB hold of the whole clip
- Surface/ImageReader as default CPU-OCR sink at this size (re-test at 1080p before dropping forever)
