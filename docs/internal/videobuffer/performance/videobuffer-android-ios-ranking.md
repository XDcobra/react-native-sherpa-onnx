# VideoBuffer ranking: Android device vs iOS simulator

Durable copy of the Cursor canvas `videobuffer-android-ios-ranking` (2026-10-29). Numbers match [videobuffer-device-bench-results.md](./videobuffer-device-bench-results.md) and the JSON dumps next to it.

Isolated suites, 360p (640×360 6 s) and 1080p (1920×1080 30 s) H.264. **Android** = Nothing A142P (real device). **iOS** = iPhone 17 Simulator / iOS 27 (not A12/A18 silicon). Compare **speedup ratios inside a platform**, not absolute milliseconds across hosts.

> **iOS numbers are simulator.** Seek, pyramid, dual-sink, and 2 fps thinning on iOS measure AVAssetReader inside the sim, not a phone. CPU convert/layout/index ratios still rank policy. A real iPhone can only confirm or overturn the HW-seek rows.

| Keep on both | Skip on both | Android-only until real iPhone | iOS keep / Android skip |
| ---: | ---: | ---: | ---: |
| 8 | 5 | 3 | 0 |

---

## Unambiguous — same direction on both platforms

Speedup is candidate vs its in-suite baseline (libyuv vs in-tree, aligned vs `ram_rgb`, slab vs per-frame mmap, I-table vs scan).

| Candidate | A 360p | A 1080p | iOS 360p | iOS 1080p | Ship |
| --- | ---: | ---: | ---: | ---: | --- |
| libyuv I420 to RGB | 23× | 24× | 34× | 33× | replace in-tree |
| libyuv scale | 8× | 5× | 10× | 8× | replace in-tree |
| libyuv rot90 | 14× | 11× | 14× | 17× | replace in-tree |
| aligned RAM ingest | 34× | 39× | 77× | 108× | yes |
| mmap slab vs per-frame | 3.8× | 2.3× | 10× | 12× | slab, never per-file |
| I-frame table vs scan | 17× | 48× | 17× | 127× | never scan |
| Gray8 / Y-plane | 4.8× vs RGB | 4.4× | 2.4× | 2.4× | when RGB unused |
| YUV to RGB on every Get | ptr 237 vs 0.04 | xor 7.9 s | xor 306 vs 15 | xor 2431 vs 117 | **no** |
| dual-sink as default | +10% ImageReader | +1.8% | 2.3× slower | tied −4% | **no default** |
| eager RGB retain | ok 360p | OOM / death | ok (sim RAM) | ok (sim RAM) | **never hold clip** |
| per-frame mmap files | 190 vs 50 ms | 491 vs 215 | 31 vs 3.2 | 174 vs 15 | **no** |

Source: Android isolated JSON 2026-10-29 (A142P SDK 36) · iOS sim `videobuffer-bench-all.json` 16:39–17:00. Retain 1080p Android never wrote a 1080p row — process died; that crash is the result.

### CPU speedup ratio (higher = stronger keep)

| Candidate | Android 360p | Android 1080p | iOS 360p (sim) | iOS 1080p (sim) |
| --- | ---: | ---: | ---: | ---: |
| I420 to RGB | 23.4× | 23.5× | 34.3× | 32.7× |
| I420 scale | 8.4× | 5.0× | 10.4× | 8.4× |
| I420 rot90 | 14.1× | 10.5× | 13.8× | 17.3× |
| Aligned ingest | 33.7× | 38.7× | 77.0× | 107.9× |
| Slab vs per-frame | 3.8× | 2.3× | 9.6× | 11.7× |
| I-table vs scan | 16.9× | 47.8× | 16.7× | 126.8× |

iOS sim inflates absolute CPU throughput (M-series host); the ranking is the ratio, which agrees on every bar.

---

## Platform-dependent — Android device vs iOS simulator

No candidate is keep-on-iOS and skip-on-Android. Every inversion is an iOS-sim HW-seek row that Android already ranked on a phone.

| Candidate | Android device | iOS simulator | Ship |
| --- | --- | --- | --- |
| §2 keyframe vs accurate seek | Keep keyframe for scrub: 23 vs 75 ms (360p), 101 vs 198 (1080p) | Inverted: accurate faster (3.3 vs 10; 28 vs 36) | Keep Android policy. Re-bench on a real iPhone. |
| §7 keyframe pyramid / scrub | Keep: 3.6× (360p), 5.2× (1080p) vs accurate full | Tied / inverted (~0–4%) | Keep Android policy until real iOS HW. |
| §6 2 fps demux thinning | Keep both sizes: 87 vs 251 (360p), 635 vs 909 (1080p); I-only 6 / 30 frames | 360p wins (39 vs 68); 1080p loses 8× (1954 vs 243). I-only still reports 90 frames | Keep from Android. iOS 1080p 2 fps is harness/seek, not policy. |
| §3 GOP window cache | Keep: 3.4× / 3.2× | 1080p 10× (stronger); 360p only 1.2× (sim overhead) | Keep. Weak 360p iOS is overhead, not a skip. |
| §8 sequential iterator | Keep: 5.1× / 3.5× vs independent seeks | 1080p 2.1× keep. 360p independent “wins” only because 12 frames vs 90 | Keep sequential. 360p iOS row is unequal work. |
| §10 encoded live ring | Keep: 55 KB vs 11 MB (360p), 182 KB vs 99.5 MB (1080p) | RGB accounted (11 / 99.5 MB); encoded bytes recorded as 0 | Keep. iOS harness did not measure encoded resident size. |

**Android-only until a real iPhone:** keyframe-first seek, keyframe pyramid, and 2 fps thinning. The phone showed a clear win; the simulator did not. Do not invert those three from sim data.

**Not a visa-versa:** libyuv, aligned alloc, slab, I-table, Gray8 are often a larger ratio on the sim (Apple Silicon). That is the same keep, not iOS policy beating Android. Eager RGB “working” on iOS is sim RAM; the Android 1080p OOM is the device constraint.

---

## Ship set (both platforms)

Replace in-tree I420 with libyuv. Aligned RAM + one mmap slab. I-frame table, never scan. Store YUV or Gray8; convert to RGB once, not on Get. Honor PTS + transform matrix (rot90 → 270). Encoded live ring, GOP cache, sequential iterator. No dual-sink default, no per-frame mmap, no eager RGB hold of the clip.
