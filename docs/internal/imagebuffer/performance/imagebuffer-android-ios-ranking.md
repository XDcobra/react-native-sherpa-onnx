# ImageBuffer ranking: Android device vs iOS simulator

Numbers match [imagebuffer-device-bench-results.md](./imagebuffer-device-bench-results.md) and the JSON dumps next to it. Plan and gates: [imagebuffer-perf-plan.md](./imagebuffer-perf-plan.md).

Isolated suites. Ranking fixture: bundled **5712×4284** JPEG (`phone-24mp.jpg`, 3 280 007 bytes, 4:3 24MP). **Android** = Nothing A142P (real device). **iOS** = iPhone 17 Simulator / iOS 27 (not A12/A18 silicon). Compare **speedup ratios inside a platform**, not absolute milliseconds across hosts.

> **iOS numbers are simulator.** ImageIO, Wuffs, and turbo on iOS measure the sim, not a phone. CPU decode/scale ratios still rank policy. A real iPhone can only confirm or overturn the ImageIO row.

Throwaway harness (screen, vendored libs, JSON pull) lives on local `exp/imagebuffer-perf`. Do not merge that branch.

---

## Product ship set (this branch)

Measurement wave **closed** 2026-10-30. No new OSS library (libyuv, libjpeg-turbo, Wuffs) ships.

| Keep on both | Skip on both |
| ---: | ---: |
| 2 | everything else in the scoreboard |

| Candidate | A142P 24MP | iOS sim 24MP | Ship |
| --- | ---: | ---: | --- |
| #8 lazy file create (8 JPEG, first ensure) | **7.4×** | **7.9×** | **yes** — file images stay compressed until ensure / OCR |
| libwebp `use_scaling` →1024 | **5.05×** | **4.42×** | **yes** — already in the SDK; keep using scaled decode |
| #4 turbo IDCT 1/4 vs full+scale | 2.99× | 3.04× | **no** — clears the wall-time gate, but needs libjpeg-turbo; turbo full-res loses to stb |
| #15 platform JPEG (`ImageDecoder` / ImageIO) | **10.1×** | 0.80× | **no** — not an Android-only JPEG path; HEIC stays platform on both |
| #1 libyuv scale →1024 | 0.33× | 0.31× | **no** |
| #2 libyuv EXIF 6 | 0.54× | 0.46× | **no** |
| #3 turbo decode vs stb | 0.56× | 0.56× | **no** — skip turbo entirely |
| #9 Wuffs PNG vs stb | 0.49× | 0.39× | **no** |
| #6 aligned-64 vs packed | 0.99× | 1.04× | **no** |
| #7 mmap slab vs per-frame | 1.00× | 1.01× | **no** |
| #12 parallel create (4 files) | 1.59× | 2.16× | **no** on device (gate ≥ 2×) |
| #14 turbo encode vs stb | 0.42× | 0.58× | **no** |

Default decoder/scale remains **Baseline** (stb + scalar bilinear). Packed RGB8, per-frame mmap files, no dest-buffer / Gray8 / OCR ImageOps / region-decode in this wave. **LiveImageBuffer** ships on this branch (shared kernel, compressed ring; not a decode-speed candidate).

**Why skip turbo despite IDCT ~3×.** Full-res turbo is slower than stb on this 24MP JPEG (0.56×). IDCT 1/4 only wins when `maxSide` is set and the longest edge is ≥ 4096. That is not enough to take a second JPEG decoder for a downscale-only path.

**Why skip Android `ImageDecoder` 10×.** Same JPEG path must stay portable C++ for host tests and iOS. ImageIO RGB8 on the sim is a wash (~20 % slower). HEIC already uses the platform decoder on both sides.

---

## Unambiguous — same direction on both platforms

Speedup is candidate vs its in-suite baseline.

| Candidate | A142P | iOS sim | Ship |
| --- | ---: | ---: | --- |
| lazy first ensure (8×24MP) | 7.4× | 7.9× | keep |
| WebP `use_scaling` | 5.05× | 4.42× | keep |
| turbo IDCT 1/4 | 2.99× | 3.04× | skip (turbo) |
| libyuv scale | 0.33× | 0.31× | skip |
| libyuv EXIF | 0.54× | 0.46× | skip |
| turbo vs stb | 0.56× | 0.56× | skip |
| Wuffs PNG | 0.49× | 0.39× | skip |
| aligned stride | 0.99× | 1.04× | skip |
| mmap slab | 1.00× | 1.01× | skip |
| turbo encode | 0.42× | 0.58× | skip |

1080p gradient (65 KB JPEG) is appendix in the results file. It never selected IDCT (`1920/2 = 960 < 1024`) and made turbo/libyuv look even worse. Ranking fixture is 24MP.

---

## Platform-dependent

| Candidate | Android device | iOS simulator | Ship |
| --- | --- | --- | --- |
| #15 JPEG HW | `ImageDecoder` **10.1×** vs turbo | ImageIO RGB8 **0.80×** vs turbo | **no** — do not split JPEG decode by platform |
| #12 parallel create | 1.59× (under ≥ 2×) | 2.16× (sim only) | **no** on device |

No candidate is keep-on-iOS and skip-on-Android except the sim-only parallel row, which is not policy.

---

## What this branch implements

Implemented on **`feat/imagebuffer-perf`**:

1. **Lazy file images** — `createFromFiles` / `FromBytes` stores paths/bytes; RGB on `EnsureFrame` / first `GetFrameRgbPtr` / FrameView. Same `state: 'lazy'` shape as PDF `lazy-lru`. `hotFrames` default 8.
2. **WebP scaled decode** — product `ImageDecoder` uses libwebp `use_scaling` when `maxSide` hits; no second `ApplyMaxSide`. JPEG/PNG stay full-decode + scalar. Host tests: `imagebuffer_decode_test.cpp`.
3. **LiveImageBuffer** — `img_live_*`, compressed ring + session spool, `recording → finished`, OCR/FrameView after finish only.

Do **not** vendor libyuv, libjpeg-turbo, or Wuffs on this branch. Host tests stay on stb + scalar.

Source: Android 24MP JSON 2026-10-30 21:42–21:58 +07 (A142P SDK 36) · iOS sim `imagebuffer-bench-all.json` same window. 1080p gradient appendix in the results file.
