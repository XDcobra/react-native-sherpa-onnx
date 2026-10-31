# ImageBuffer benches — 24MP phone JPEG (ranking)

Product keep/skip: [`imagebuffer-android-ios-ranking.md`](./imagebuffer-android-ios-ranking.md). Plan: [`imagebuffer-perf-plan.md`](./imagebuffer-perf-plan.md).

Isolated suites, 2026-10-30 21:42–21:58 +07. Fixture: bundled **5712×4284** JPEG (`phone-24mp.jpg`, **3 280 007 bytes**, `fixtureKind=phone-24mp`). 4:3 24MP matches iPhone 18 default / Galaxy S26 24MP mode. `idctDenom=4` (`5712/4 = 1428 ≥ 1024`). 5 repeats, p50. Process RSS/PSS still ~400 MB RN process — do **not** rank allocator/RSS.

| Platform | App | Raw JSON |
|----------|-----|----------|
| **Nothing A142P** (`PacmanPro` / `MT6886`), SDK 36 | `com.xdcobra.voicelab` | [imagebuffer-bench-android-24mp/](./imagebuffer-bench-android-24mp/) |
| iPhone 17 **simulator**, iOS 27 (not a device ranking) | `com.xdcobra.voiceexample` | [imagebuffer-bench-ios-sim-24mp/](./imagebuffer-bench-ios-sim-24mp/) |

All **12/12** suites wrote JSON on both, no `error`. Lazy used **8** files (not 30); parallel used **4** (not 8) to avoid 24MP OOM. PNG is a re-encode of the same photo (**23 107 552 bytes**). ImageIO row copies RGB8 (`rgbBytes=73410624` = 5712×4284×3).

Earlier 1080p gradient run is kept below as history.

## Verdict (24MP)

| Item | A142P × | iOS sim × | Keep? | Gate |
|------|---------|-----------|-------|------|
| #1 libyuv scale →1024 | **0.33×** | 0.31× | **no** | ≥ 3× |
| #2 libyuv EXIF 6 | **0.54×** | 0.46× | **no** | ≥ 3× |
| #3 turbo decode vs stb | **0.56×** | 0.56× | **no** | ≥ 1.5× |
| #4 turbo IDCT 1/4 vs full+scale | **2.99×** | **3.04×** | **yes** (when longest ≥ 4096 and `maxSide` set) | wall |
| #6 aligned-64 vs packed | 0.99× | 1.04× | **no** | ≥ 1.2× |
| #7 mmap slab vs per-frame | 1.00× | 1.01× | **no** | material win |
| #8 lazy create (8 JPEG) | create huge; +ensure0 **7.4×** | +ensure0 **7.9×** | **yes (latency)** | RSS not isolated |
| #9 Wuffs PNG vs stb | 0.49× | 0.39× | **no** | ≥ 1.5× |
| #12 parallel create (4 files) | 1.59× | **2.16×** | **no** on device (gate ≥ 2×); sim only | ≥ 2× |
| #14 turbo encode vs stb | 0.42× | 0.58× | **no** | ≥ 2× |
| #15 platform HW vs turbo | **10.1×** `ImageDecoder` | 0.80× ImageIO RGB8 | **optional** (keep C++ for host/fallback). 10× is the Android measurement; iOS ~20 % is a wash | ≥ 1.5× |
| libwebp `use_scaling` | **5.05×** | **4.42×** | **yes** | (suite) |

**Keep (product):** lazy file create, WebP scaled decode (already in SDK). **Skip turbo** (and therefore JPEG IDCT 1/4, even though it cleared ~3×). Skip Android-only platform JPEG. The 10× is Android `ImageDecoder`; iOS ImageIO JPEG is a wash (~20 % on sim). Full-res turbo still loses to stb on this 24MP JPEG — do not switch the default decoder.

**Skip as default:** libyuv scale/rotate, turbo full-res decode/encode, Wuffs, aligned stride, mmap slab, parallel create (device 1.59×). Default profile stays **Baseline** (stb + scalar), plus the keep flags above.

## Android A142P (p50 ms)

| Suite | Baseline | Candidate | × |
|-------|----------|-----------|---|
| `decode_jpeg_stb_vs_turbo` | stb 1469 | turbo 2615 | 0.56 |
| `decode_jpeg_full_then_scale_vs_idct` maxSide=1024 denom=4 | turbo full+scale 3426 | turbo IDCT 1146 | **2.99** |
| `scale_scalar_vs_libyuv` maxSide=1024 | scalar 580 | libyuv 1769 | 0.33 |
| `exif_scalar_vs_libyuv` | scalar 2077 | libyuv 3829 | 0.54 |
| `png_stb_vs_wuffs` | stb 2666 | wuffs 5448 | 0.49 |
| `webp_full_vs_scaled` maxSide=1024 | full+scale 801 | `use_scaling` 159 | **5.05** |
| `eager_vs_lazy_30page` (8 files) | eager 18074 | lazy 0.015; +ensure0 2455 | first page **7.4×** |
| `packed_vs_aligned_stride` | packed 1813 | aligned64 1832 | 0.99 |
| `mmap_per_frame_vs_slab` (2 pages) | per-frame 1426 | slab 1419 | 1.00 |
| `serial_vs_parallel_create` (4 files) | serial 8563 | parallel 5376 | 1.59 |
| `jpeg_turbo_encode` | stb_write 1676 | turbo 3975 | 0.42 |
| `platform_hw_decode` | portable turbo 3274 | `ImageDecoder` 325 | **10.1** |

PSS ~396–421 MB (`pssKb` 395813–421143).

## iOS Simulator (p50 ms)

| Suite | Baseline | Candidate | × |
|-------|----------|-----------|---|
| `decode_jpeg_stb_vs_turbo` | stb 718 | turbo 1274 | 0.56 |
| `decode_jpeg_full_then_scale_vs_idct` maxSide=1024 denom=4 | turbo full+scale 1321 | turbo IDCT 434 | **3.04** |
| `scale_scalar_vs_libyuv` maxSide=1024 | scalar 221 | libyuv 718 | 0.31 |
| `exif_scalar_vs_libyuv` | scalar 749 | libyuv 1612 | 0.46 |
| `png_stb_vs_wuffs` | stb 1001 | wuffs 2542 | 0.39 |
| `webp_full_vs_scaled` maxSide=1024 | full+scale 284 | `use_scaling` 64.3 | **4.42** |
| `eager_vs_lazy_30page` (8 files) | eager 6030 | lazy 0.006; +ensure0 767 | first page **7.9×** |
| `packed_vs_aligned_stride` | packed 745 | aligned64 713 | 1.04 |
| `mmap_per_frame_vs_slab` (2 pages) | per-frame 393 | slab 387 | 1.01 |
| `serial_vs_parallel_create` (4 files) | serial 2970 | parallel 1378 | **2.16** |
| `jpeg_turbo_encode` | stb_write 744 | turbo 1292 | 0.58 |
| `platform_hw_decode` | portable turbo 1240 | `ImageIO` RGB8 1546 | 0.80 |

---

# Appendix: 1080p gradient (Nothing A142P, SDK 36)

Isolated ranking suites from the throwaway example screen, 2026-10-30 19:20–19:30 +07. Force-stop between suites. Device: **Nothing A142P** (`PacmanPro` / Dimensity `MT6886`), Android SDK 36, app `com.xdcobra.voicelab`.

Fixture: generated **1920×1080 gradient** JPEG/PNG/WebP (ranking preset), 5 repeats, p50 vs named baseline. JPEG on disk is **65 491 bytes** — not a camera photo. Process `rssBytes` / `pssKb` stay ~400–500 MB for every row (app + RN); do **not** rank allocator/RSS from those fields.

Raw JSON: [imagebuffer-bench-android-1920x1080/](./imagebuffer-bench-android-1920x1080/). All **12/12** suites wrote JSON, no `error`.

## Verdict

| Item | × vs baseline (p50) | Keep? | Gate in plan |
|------|---------------------|-------|--------------|
| #1 libyuv scale (1080p→1024) | **0.71×** (148 vs 104 ms) | **no** | ≥ 3× |
| #2 libyuv EXIF 6 | **0.47×** (247 vs 116 ms) | **no** | ≥ 3× |
| #3 libjpeg-turbo decode vs stb | **0.44×** (183 vs 81 ms) | **no on this fixture** | ≥ 1.5× |
| #4 JPEG IDCT scale vs full+scale | **1.00×** (257 vs 257 ms) | **not exercised** | wall + RSS |
| #6 aligned-64 vs packed libyuv | **0.99×** | **no** | ≥ 1.2× vs packed |
| #7 mmap slab vs per-frame (2 pages) | **1.02×** | **no** | material win |
| #8 lazy create (30 JPEG) | create **104 250×**; +ensure0 **28×** vs eager-all | **yes (latency)** | RSS not proven |
| #9 Wuffs PNG vs stb | **0.54×** (142 vs 76 ms) | **no** | ≥ 1.5× |
| #12 parallel create (8 files) | **1.23×** (790 vs 975 ms) | **no** | ≥ 2× |
| #14 turbo JPEG encode vs stb | **0.34×** (314 vs 107 ms) | **no** | ≥ 2× |
| #15 Android `ImageDecoder` vs turbo | **16.5×** (14.3 vs 236 ms) | **yes, optional** | ≥ 1.5× |
| libwebp `use_scaling` vs full+scale | **6.65×** (16.9 vs 113 ms) | **yes** | (suite, not numbered) |
| #5 dest buffer / #10 Gray8 / #11 OCR ops / #13 crop | — | not measured | |
| #16 LiveImageBuffer | — | later | |

**Keep on this device/fixture:** file-image lazy create (decode on ensure), WebP scaled decode, optional platform JPEG decode.

**Skip as default on this fixture:** libyuv scale/rotate, turbo decode/encode, Wuffs PNG, aligned stride, mmap slab, parallel create. Literature × assumed photographic 8–12 MP; this run is a 2 MP synthetic. Re-rank #1/#3/#4 on a real 12 MP JPEG before treating turbo/libyuv as permanently dead — 1080p→1024 also never selects IDCT 1/2 (`1920/2 = 960 < 1024`, `PickIdctDenom` returns 1).

Default profile stays **Baseline** (stb + scalar).

## Suites (p50 ms)

| Suite | Baseline | Candidate | × |
|-------|----------|-----------|---|
| `decode_jpeg_stb_vs_turbo` | stb 81.0 | turbo 182.9 | 0.44 |
| `decode_jpeg_full_then_scale_vs_idct` maxSide=1024 | turbo full+scale 256.9 | turbo IDCT 257.5 | 1.00 |
| `scale_scalar_vs_libyuv` maxSide=1024 | scalar 104.3 | libyuv 147.5 | 0.71 |
| `exif_scalar_vs_libyuv` | scalar 115.9 | libyuv 247.5 | 0.47 |
| `png_stb_vs_wuffs` | stb 76.3 | wuffs 141.9 | 0.54 |
| `webp_full_vs_scaled` maxSide=1024 | full+scale 112.6 | `use_scaling` 16.9 | **6.65** |
| `eager_vs_lazy_30page` (30 files) | eager 2983 | lazy 0.029; lazy+ensure0 105.6 | create huge; first page **28×** |
| `packed_vs_aligned_stride` | packed 192.0 | aligned64 193.1 | 0.99 |
| `mmap_per_frame_vs_slab` (2 pages) | per-frame 298.2 | slab 293.2 | 1.02 |
| `serial_vs_parallel_create` (8 files) | serial 975 | parallel 790 | 1.23 |
| `jpeg_turbo_encode` | stb_write 107.2 | turbo 314.0 | 0.34 |
| `platform_hw_decode` | portable turbo 235.7 | `ImageDecoder` 14.3 | **16.5** |

PSS after each suite: 394–411 MB (`pssKb` 403297–420481). Candidate RSS never diverges in a way that can rank peak decode RAM.

## Notes for a later 8–12 MP rerun

- Use a camera JPEG whose longest edge is ≥ 2048 so IDCT 1/2 can fire; ≥ 4096 for 1/4.
- Measure buffer-local RSS (before/after create), not `/proc/self/statm` of the RN process.
- Platform HW (#15) already clears 1.5× on 1080p; keep C++ path for host tests.

---

# ImageBuffer iOS Simulator benches (iPhone 17, iOS 27)

Isolated ranking suites from the throwaway example screen, 2026-10-30 21:21–21:28 +07 (JSON `loggedAt` is UTC). `platform_hw_decode` re-run 21:33 +07 after RGB8 draw. Force-stop between suites (new PID each run). Host: **Mac16,10**, sim **iPhone 17 / iOS 27.0**, UDID `B6800F46-62D6-4AE2-A4FB-E2A625E16CC6`, app `com.xdcobra.voiceexample`.

Fixture is the same **1920×1080 gradient** (JPEG **65 491 bytes**, PNG **97 616 bytes**). Simulator is **not** an iOS-device ranking — same caveat as VideoBuffer. Process `rssBytes` stay ~321–467 MB (app + RN); do **not** rank allocator/RSS.

Raw JSON: [imagebuffer-bench-ios-sim-1920x1080/](./imagebuffer-bench-ios-sim-1920x1080/). All **12/12** suites wrote JSON, no `error`.

## Verdict vs A142P

Same keep/skip as Android on this fixture: lazy create, WebP `use_scaling`. libyuv / turbo / Wuffs / aligned / slab still lose. Parallel create is closer to the ≥ 2× gate here (**1.80×**) than on A142P (1.23×) but still under.

`platform_hw_decode` after RGB8 draw (`ImageIO rgb8 1920x1080 bytes=6220800`): **0.87×** (103.6 vs 90.5 ms). First 4587× row was invalid (deferred `CGImage` only) and is discarded. Gate ≥ 1.5× → **no** on this sim. Android `ImageDecoder` 16.5× on A142P still holds.

IDCT still not exercised (`1920/2 = 960 < 1024`).

## Suites (p50 ms)

| Suite | Baseline | Candidate | × |
|-------|----------|-----------|---|
| `decode_jpeg_stb_vs_turbo` | stb 39.2 | turbo 91.5 | 0.43 |
| `decode_jpeg_full_then_scale_vs_idct` maxSide=1024 | turbo full+scale 129.8 | turbo IDCT 129.9 | 1.00 |
| `scale_scalar_vs_libyuv` maxSide=1024 | scalar 54.9 | libyuv 80.0 | 0.69 |
| `exif_scalar_vs_libyuv` | scalar 60.7 | libyuv 134.0 | 0.45 |
| `png_stb_vs_wuffs` | stb 32.2 | wuffs 79.4 | 0.40 |
| `webp_full_vs_scaled` maxSide=1024 | full+scale 57.9 | `use_scaling` 8.32 | **6.95** |
| `eager_vs_lazy_30page` (30 files) | eager 1213 | lazy 0.015; lazy+ensure0 38.7 | create huge; first page **31×** |
| `packed_vs_aligned_stride` | packed 79.2 | aligned64 80.5 | 0.98 |
| `mmap_per_frame_vs_slab` (2 pages) | per-frame 115.8 | slab 113.9 | 1.02 |
| `serial_vs_parallel_create` (8 files) | serial 320 | parallel 178 | 1.80 |
| `jpeg_turbo_encode` | stb_write 43.2 | turbo 106.0 | 0.41 |
| `platform_hw_decode` | portable turbo 90.5 | `ImageIO` RGB8 103.6 | **0.87** |

RSS after rows: 321–467 MB. Candidate RSS never diverges in a way that can rank peak decode RAM.

## Pull command (simulator)

```
xcrun simctl get_app_container <UDID> com.xdcobra.voiceexample data
# Documents/imagebuffer-bench-all.json
# Documents/imagebuffer-bench.ndjson
log show --last 2h --predicate 'eventMessage CONTAINS "ImageBufferBench"'
```
