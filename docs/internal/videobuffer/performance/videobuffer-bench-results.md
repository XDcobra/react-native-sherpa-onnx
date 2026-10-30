# VideoBuffer host benchmark results

- Size: **medium** `640x360` × `120` frames (79.1016 MiB RGB)
- Repeats: 5 (median)
- Host: C++ `VideoRegistry` SOT, no device / no FFmpeg decode
- Ingest times **exclude** synthetic RGB generation (prefilled frames)
- `xor_*` walks every RGB byte (bandwidth). `ptr_seq` only calls GetFrameRgbPtr
- `xor_stride_ocr` = every 15th frame (2 fps from 30 fps orchestration)

## Raw timings

| backing | ingest_ms | ptr_seq | xor_cold | xor_warm | xor_stride | xor_window | res_ingest_MiB | res_stride_MiB | disk_MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `ram_rgb` | 1.97658 | 0.00475 | 1.28308 | 1.21087 | 0.084458 | 1.59521 | 79.1016 | 79.1016 | 0 |
| `ram_rgb_copyout` | 2.01279 | 1.29317 | 2.00283 | 1.99283 | 0.135833 | 3.03642 | 79.1016 | 79.7607 | 0 |
| `ram_rgb_aligned` | 2.21304 | 0.006 | 1.30279 | 1.20629 | 0.096625 | 1.64792 | 79.1016 | 79.1016 | 0 |
| `mmap_per_frame` | 35.5437 | 0.109875 | 4.80933 | 1.29146 | 0.3375 | 1.64108 | 0 | 0 | 79.1016 |
| `mmap_slab` | 6.45258 | 0.007916 | 1.30983 | 1.21388 | 0.088916 | 1.64721 | 0 | 0 | 79.1016 |
| `mmap_slab_madvise` | 6.54554 | 0.395125 | 1.66013 | 1.597 | 0.113042 | 2.20454 | 0 | 0 | 79.1016 |
| `mmap_slab_populate` | 2.07425 | 0.25175 | 1.50429 | 1.44042 | 0.099583 | 2.11346 | 0 | 0 | 79.1016 |
| `yuv420_ram` | 16.0086 | 36.2445 | 36.9946 | 36.9661 | 2.44971 | 56.6729 | 39.5508 | 40.21 | 0 |
| `yuv420_slab` | 18.9192 | 36.3071 | 37.0532 | 37.0094 | 2.45579 | 56.625 | 0 | 0.65918 | 39.5508 |
| `gray8_ram` | 1.6675 | 0.936208 | 1.68892 | 1.72125 | 0.116333 | 2.55171 | 26.3672 | 27.0264 | 0 |
| `gray8_slab` | 3.24271 | 1.537 | 1.72071 | 1.71108 | 0.121583 | 2.61463 | 0 | 0.65918 | 26.3672 |
| `lazy_decode_lru` | 0.002458 | 4.77663 | 5.41483 | 5.48971 | 0.362 | 5.77933 | 0 | 5.27344 | 0 |
| `live_ring` | 1.66521 | 0.001792 | 0.133375 | 0.117541 | 0.010291 | 0.139125 | 10.5469 | 10.5469 | 0 |

## Percent vs `ram_rgb` (positive = better)

| backing | ingest | ptr_seq | xor_cold | xor_warm | xor_stride | res_ingest | res_after_stride |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ram_rgb_copyout` | -1.8319% | -27124.6% | -56.0952% | -64.5779% | -60.8291% | 0% | -0.833333% |
| `ram_rgb_aligned` | -11.963% | -26.3158% | -1.53599% | 0.378487% | -14.406% | 0% | 0% |
| `mmap_per_frame` | -1698.24% | -2213.16% | -274.826% | -6.65494% | -299.607% | 100% | 100% |
| `mmap_slab` | -226.451% | -66.6526% | -2.08474% | -0.247755% | -5.27836% | 100% | 100% |
| `mmap_slab_madvise` | -231.154% | -8218.42% | -29.3855% | -31.8881% | -33.844% | 100% | 100% |
| `mmap_slab_populate` | -4.9412% | -5200% | -17.2403% | -18.9566% | -17.9083% | 100% | 100% |
| `yuv420_ram` | -709.914% | -762942% | -2783.25% | -2952.84% | -2800.5% | 50% | 49.1667% |
| `yuv420_slab` | -857.165% | -764260% | -2787.83% | -2956.42% | -2807.71% | 100% | 99.1667% |
| `gray8_ram` | 15.6372% | -19609.6% | -31.6294% | -42.1493% | -37.7407% | 66.6667% | 65.8333% |
| `gray8_slab` | -64.0563% | -32257.9% | -34.1072% | -41.3096% | -43.9568% | 100% | 99.1667% |
| `lazy_decode_lru` | 99.8756% | -100461% | -322.017% | -353.367% | -328.615% | 100% | 93.3333% |
| `live_ring` | 15.7531% | 62.2737% | 89.6051% | 90.2929% | 87.8152% | 86.6667% | 86.6667% |

## Notes

- `res_*` is buffer-accounted heap, not OS RSS. mmap reports ~0 heap and pages in on first `xor_seq_cold`.
- `live_ring` drops frames outside the last 16; full sequential is not comparable (nullptrs skipped).
- `lazy_decode_lru` stores no pixels at ingest; `res_after_stride` is the hot RGB window after sampled OCR.
- YUV/Gray convert into a reused RGB scratch on Get (fair for RGB OCR).
