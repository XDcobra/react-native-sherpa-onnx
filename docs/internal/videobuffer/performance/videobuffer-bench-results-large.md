# VideoBuffer host benchmark results

- Size: **large** `1280x720` × `90` frames (237.305 MiB RGB)
- Repeats: 3 (median)
- Host: C++ `VideoRegistry` SOT, no device / no FFmpeg decode
- Ingest times **exclude** synthetic RGB generation (prefilled frames)
- `xor_*` walks every RGB byte (bandwidth). `ptr_seq` only calls GetFrameRgbPtr
- `xor_stride_ocr` = every 15th frame (2 fps from 30 fps orchestration)

## Raw timings

| backing | ingest_ms | ptr_seq | xor_cold | xor_warm | xor_stride | xor_window | res_ingest_MiB | res_stride_MiB | disk_MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `ram_rgb` | 8.93783 | 0.012917 | 4.90017 | 3.79967 | 0.345167 | 6.61742 | 237.305 | 237.305 | 0 |
| `ram_rgb_copyout` | 8.74179 | 5.00437 | 6.40846 | 6.12054 | 0.413084 | 11.2429 | 237.305 | 239.941 | 0 |
| `ram_rgb_aligned` | 6.63575 | 0.006916 | 4.12887 | 4.004 | 0.281875 | 7.12875 | 237.305 | 237.305 | 0 |
| `mmap_per_frame` | 88.1483 | 0.098416 | 14.2893 | 3.80246 | 1.00754 | 6.69646 | 0 | 0 | 237.305 |
| `mmap_slab` | 19.8377 | 0.00825 | 3.97129 | 3.877 | 0.278833 | 6.65417 | 0 | 0 | 237.305 |
| `mmap_slab_madvise` | 19.6115 | 1.052 | 4.83558 | 4.91033 | 0.342833 | 8.43046 | 0 | 0 | 237.305 |
| `mmap_slab_populate` | 6.17842 | 0.584708 | 4.43404 | 4.29483 | 0.296417 | 7.58971 | 0 | 0 | 237.305 |
| `yuv420_ram` | 49.2114 | 109.265 | 151.764 | 110.818 | 7.39846 | 206.796 | 118.652 | 121.289 | 0 |
| `yuv420_slab` | 57.9481 | 108.528 | 110.976 | 111.065 | 7.40208 | 207.062 | 0 | 2.63672 | 118.652 |
| `gray8_ram` | 4.94092 | 4.51992 | 5.11742 | 5.13138 | 0.37825 | 9.60567 | 79.1016 | 81.7383 | 0 |
| `gray8_slab` | 9.69163 | 4.74038 | 5.18542 | 5.22221 | 0.381083 | 9.43571 | 0 | 2.63672 | 79.1016 |
| `lazy_decode_lru` | 0.002666 | 14.85 | 16.9215 | 17.2677 | 1.16279 | 18.999 | 0 | 21.0938 | 0 |
| `live_ring` | 5.68958 | 0.001541 | 0.722417 | 0.710625 | 0.040708 | 0.871292 | 42.1875 | 42.1875 | 0 |

## Percent vs `ram_rgb` (positive = better)

| backing | ingest | ptr_seq | xor_cold | xor_warm | xor_stride | res_ingest | res_after_stride |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ram_rgb_copyout` | 2.1934% | -38642.5% | -30.7804% | -61.081% | -19.6766% | 0% | -1.11111% |
| `ram_rgb_aligned` | 25.7566% | 46.4582% | 15.7401% | -5.37766% | 18.3366% | 0% | 0% |
| `mmap_per_frame` | -886.238% | -661.911% | -191.609% | -0.0734538% | -191.9% | 100% | 100% |
| `mmap_slab` | -121.953% | 36.1307% | 18.956% | -2.03526% | 19.2179% | 100% | 100% |
| `mmap_slab_madvise` | -119.422% | -8044.31% | 1.318% | -29.2306% | 0.676194% | 100% | 100% |
| `mmap_slab_populate` | 30.8734% | -4426.65% | 9.51245% | -13.0318% | 14.1236% | 100% | 100% |
| `yuv420_ram` | -450.597% | -845798% | -2997.12% | -2816.53% | -2043.44% | 50% | 48.8889% |
| `yuv420_slab` | -548.346% | -840094% | -2164.73% | -2823.02% | -2044.49% | 100% | 98.8889% |
| `gray8_ram` | 44.7191% | -34892% | -4.43352% | -35.048% | -9.58464% | 66.6667% | 65.5556% |
| `gray8_slab` | -8.43372% | -36598.7% | -5.82123% | -37.4386% | -10.4054% | 100% | 98.8889% |
| `lazy_decode_lru` | 99.9702% | -114865% | -245.324% | -354.452% | -236.878% | 100% | 91.1111% |
| `live_ring` | 36.3427% | 88.07% | 85.2573% | 81.2977% | 88.2063% | 82.2222% | 82.2222% |

## Notes

- `res_*` is buffer-accounted heap, not OS RSS. mmap reports ~0 heap and pages in on first `xor_seq_cold`.
- `live_ring` drops frames outside the last 16; full sequential is not comparable (nullptrs skipped).
- `lazy_decode_lru` stores no pixels at ingest; `res_after_stride` is the hot RGB window after sampled OCR.
- YUV/Gray convert into a reused RGB scratch on Get (fair for RGB OCR).
