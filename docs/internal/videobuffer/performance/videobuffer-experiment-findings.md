# VideoBuffer experiments — findings

**Tree:** `/Users/felix/dev/react-native-sherpa-onnx-videobuffer` (clone of `feat/add-ocr-support`).  
**SOT:** C++ `VideoRegistry` (`android/src/main/cpp/video/`) — same role as `ImageRegistry`. JNI / ObjC are wrappers later.  
**Harness:** `test/cpp/videobuffer/videobuffer_bench` + `videobuffer_host_test`. Host only (no device, no FFmpeg). Pixel contents are synthetic document-like RGB; timings measure **buffer ingest + GetFrameRgbPtr + full-frame byte walks**, not a real decoder.

Video-only candidates (GOP, seek, Surface, Y-plane, …), not measured here: [`docs/future-work/videobuffer-perf-future-work.md`](../../../future-work/videobuffer-perf-future-work.md).

Raw tables: [videobuffer-bench-results.md](./videobuffer-bench-results.md) (640×360×120, 79 MiB) and [videobuffer-bench-results-large.md](./videobuffer-bench-results-large.md) (1280×720×90, 237 MiB). Percents below vs `ram_rgb` (vector-of-vectors, zero-copy Get) unless noted. Positive = better.

Host: macOS AppleClang Release. Access `xor_*` XORs every RGB byte (bandwidth). `ptr_seq` only obtains the pointer.

---

## Recommended production shape

```
                    VideoRegistry (C++ SOT)
                    buffer id: vid_off_<uuid>
          ┌─────────────┬──────────────────┬─────────────────┐
          │ LiveRing    │ Immutable        │ LazyDecode      │
          │ last N RGB  │ RAM slab | mmap  │ source file +   │
          │ (capture)   │ one .vbuf file   │ hot RGB LRU     │
          └─────────────┴──────────────────┴─────────────────┘
                              GetFrameRgbPtr  (zero-copy)
```

| Mode | When | Backing |
|------|------|---------|
| **Live** | Camera / screen / in-flight decode | Fixed RGB ring (`ringCapacity`, default 16) |
| **Immutable small** | Clip under mmap threshold | One contiguous RAM slab (not `vector<vector>`) |
| **Immutable large** | Default for video (one 720p frame is already ~2.6 MiB RGB) | **One mmap slab** + prefault on ingest |
| **Lazy** | VLM OCR without native video; 2 fps screenshots from 30 fps | Keep compressed source; decode into `hotFrames` RGB LRU (PDF `lazy-lru` analog) |

Do **not** copy ImageBuffer’s per-frame `*_fN.rgb8` files. That is the worst ingest and cold-scan path we measured for video.

---

## What to ship (ranked)

### 1. Lazy decode + hot RGB LRU — **91% less RAM** on sampled OCR

Orchestration path: VLM has no native video, so we screenshot / decode every Nth frame.

| | `ram_rgb` | `lazy_decode_lru` (hot=8) |
|--|-----------|---------------------------|
| Heap after 2 fps sampling (large) | 237 MiB | **21 MiB (−91%)** |
| Heap after sampling (medium) | 79 MiB | **5.3 MiB (−93%)** |
| Ingest | copies every pixel | **~0 ms / −100%** (metadata only) |
| Stride walk | 0.35 ms | 1.16 ms (must decode those frames) |

**Why:** Video OCR almost never needs every 30 fps RGB raster. Paying decode+RGB only for the sampled window is the same trick as PDF `strategy: 'lazy-lru'` + `hotFrames`. Full sequential decode is ~3.5× slower than eager RGB — acceptable, because that is the rare path.

**Ship as default for file-backed video OCR.** `EnsureFrame(i)` rasters into the LRU; neighbors can prefetch like PDF.

### 2. Zero-copy `GetFrameRgbPtr` — **~38% faster** pixel walks vs copy-out

| | zero-copy `ram_rgb` | `ram_rgb_copyout` |
|--|---------------------|-------------------|
| xor_warm medium | 1.21 ms | 1.99 ms (**−65%**) |
| xor_warm large | 3.80 ms | 6.12 ms (**−61%**) |
| ptr_seq large (Get only) | 0.01 ms | 5.00 ms (full 237 MiB memcpy) |

**Why:** ImageBuffer already learned this (`GetFrameRgbPtr` / `ResolveFrameRgb`). Bridging RGB through JS `ArrayBuffer` copies will dominate before the OCR engine runs. Keep the pointer in C++ until the vision encoder consumes it.

### 3. One mmap slab, not per-frame files — **~9× faster ingest**, **~3× faster cold scan**

Image analog = one temp file per frame. Audio analog = one `.f32` mapping. Video must follow **audio**.

| large 237 MiB | ingest | xor_cold | xor_warm | heap |
|---------------|--------|----------|----------|------|
| `ram_rgb` | 8.9 ms | 4.9 ms | 3.8 ms | 237 MiB |
| `mmap_per_frame` | **88 ms (−886%)** | **14.3 ms (−192%)** | 3.8 ms | 0 |
| `mmap_slab` | 19.8 ms | **4.0 ms (+19%)** | 3.9 ms | 0 |
| `mmap_slab_populate` | **6.2 ms (+31%)** | 4.4 ms | 4.3 ms | 0 |

**Why:** 90× `open/ftruncate/mmap/msync/munmap` beats the allocator, then cold sequential OCR faults 90 separate mappings. One slab is a sequential file; once warm, it matches RAM bandwidth. Video always exceeds ImageBuffer’s 6–12 MiB mmap threshold (one 720p frame is enough), so **offline video should default to slab mmap**.

Prefault (`MAP_POPULATE` on Linux, first-touch / `MADV_WILLNEED` once on the whole file on Apple) makes ingest as cheap as RAM because pages are already resident for the memcpy.

### 4. Live ring — **82–87% less RAM** during capture

| | heap | semantics |
|--|------|-----------|
| `ram_rgb` 90×720p | 237 MiB | keeps the whole clip |
| `live_ring` cap=16 | **42 MiB (−82%)** | only the last 16 frames |

**Why:** Same as LiveAudioBuffer. Capture cannot retain unbounded RGB. OCR of “the current frame” / last second is a ring. Finalize live → offline slab when the user stops (ImageBuffer future-work already named this).

Full-scan timings on the ring are **not** comparable (dropped frames return null). The RAM number is the product metric.

### 5. Contiguous RAM slab for tiny clips — **+26% ingest** at 720p

`ram_rgb_aligned` (one allocation) vs vector-of-vectors: large ingest **+26%**, xor_cold **+16%**. Medium is within noise after warmup.

**Why:** Per-frame `std::vector` is ImageBuffer-shaped (tens of pages). Video has hundreds of frames. One slab matches OfflineAudioBuffer’s `InMemory` layout.

### 6. Optional Gray8 — **67% less RAM**, **35% slower** RGB Get

| large | heap | xor_warm |
|-------|------|----------|
| RGB RAM | 237 MiB | 3.8 ms |
| Gray8 RAM | **79 MiB (−67%)** | 5.1 ms (−35%) |

Expand-to-RGB scratch on Get (already reused). Worth it when the OCR detector is grayscale (same note as ImageBuffer future-work). Do not make it the default if the VLM wants color.

### 7. YUV420 as *storage* only, never convert on every Get

Native decoded video is YUV. We tried planar 4:2:0 + RGB restore on every `GetFrameRgbPtr`:

| large | heap | xor_warm |
|-------|------|----------|
| RGB RAM | 237 MiB | 3.8 ms |
| YUV RAM | 119 MiB (−50%) | **111 ms (−2800%)** |

A 28× tax is not a storage win. **If** we keep YUV (decoder output, 50% RAM): convert **once** into the same hot RGB LRU as lazy mode, then zero-copy that RGB to OCR. Do not YUV→RGB per Get.

---

## What not to ship

| Idea | Measured | Why it loses |
|------|----------|--------------|
| Per-frame mmap files | ingest **9×** slower, cold scan **3×** | syscall + mapping storm; OK for 10 PDF pages, not 90–1800 video frames |
| `madvise(WILLNEED/SEQUENTIAL)` **per Get** | ptr_seq **80×** slower; xor_warm **−29%** | syscall overhead on this host dwarfs prefetch. Advise **once** on the whole slab at freeze, if at all |
| Forced RGB copy-out at the bridge | xor_warm **−61%** | extra memcpy of the whole clip |
| Eager RGB for sampled VLM OCR | 10× more RAM than lazy LRU | unused frames never enter the model |
| YUV→RGB on every Get | **~28×** slower walks | conversion is the engine; cache RGB |

---

## Threshold / lifecycle (map onto existing policy)

Reuse `ImageMmapThreshold` numbers as a *floor*, but video will almost always mmap:

- 640×360 RGB = 0.66 MiB/frame → 10 frames already past the 6 MiB Android file-origin threshold.
- 1280×720 RGB = 2.64 MiB/frame → 3 frames.

Policy:

1. `Live` → ring, never mmap the live window (too much remap). Optional disk spool of compressed GOPs if ingest outruns OCR (not benched here).
2. `Immutable` with known `frameCount` → pre-truncate one `vid_off_<uuid>.vbuf`, `MAP_SHARED`, populate/prefault, append by memcpy into the mapping, then consumers `GetFrameRgbPtr`.
3. `Lazy` from MP4 / camera session → retain compressed bytes (or the original file via mmap of the container), `EnsureFrame` decodes into LRU RGB (hotFrames 8, clamp 1..32 like PDF).
4. Orphan sweep: prefix `vid_off_`, suffix `.vbuf` / `.rgb8`, 1 h maxAge (ImageBuffer analog).
5. Single C++ registry; Android JNI + iOS `.mm` only marshal ids / paths.

---

## How this feeds video OCR

Two model classes, one buffer:

1. **Native video VLMs** — feed a time window. Buffer must give sequential YUV or RGB cheaply → mmap slab + zero-copy. Ring while recording.
2. **Image VLMs (PaddleOCR-VL, etc.)** — no video ops. Orchestration screenshots at 1–2 fps → **lazy LRU** is the feature: `EnsureFrame(k)` is the screenshot. Do not build an eager 30 fps RGB buffer first.

---

## Limits of these benches

- No FFmpeg / MediaCodec / AVFoundation decode cost. Lazy “decode” is `FillSyntheticRgb`. Real JPEG/H.264 decode is slower, which **increases** the value of not decoding unused frames.
- Host page cache is generous; a phone with memory pressure will punish `mmap_per_frame` and help slab+lazy more.
- `ptr_seq` percents vs a ~0.01 ms baseline are not meaningful; use xor_warm / ingest / heap.
- `live_ring` full-scan times skip evicted frames.

Re-run:

```bash
cmake -S test/cpp/videobuffer -B test/cpp/videobuffer/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_SYSROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk
cmake --build test/cpp/videobuffer/build --target videobuffer_bench videobuffer_host_test
./test/cpp/videobuffer/build/videobuffer_host_test
VIDEOBUFFER_BENCH_SIZE=large VIDEOBUFFER_BENCH_REPEATS=3 \
  ./test/cpp/videobuffer/build/videobuffer_bench --out docs/internal/videobuffer/performance/videobuffer-bench-results-large.md
```

---

## Code map

| Path | Role |
|------|------|
| `android/src/main/cpp/video/VideoTypes.h` | Backing enum, info structs |
| `android/src/main/cpp/video/VideoBuffer.h/.cpp` | `VideoRegistry` SOT |
| `test/cpp/videobuffer/videobuffer_host_test.cpp` | Correctness (RAM/mmap/lazy/ring) |
| `test/cpp/videobuffer/videobuffer_bench.cpp` | Host microbench |
| `test/cpp/CMakeLists.txt` | Also wired into the main host-test project |
