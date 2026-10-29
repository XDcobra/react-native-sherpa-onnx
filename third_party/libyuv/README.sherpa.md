# libyuv (vendored)

Pinned snapshot of [libyuv](https://chromium.googlesource.com/libyuv/libyuv/) for VideoBuffer color convert / scale / rotate.

| Field | Value |
|---|---|
| Commit | `63e54f7374680a03beb3fb595ea756354dabaffd` |
| Date | 2026-10-27 |
| Upstream version label | 1976 (`README.chromium`) |
| Local modifications | **none** |

## Included

- `include/`
- `source/*.cc` needed on Android (armeabi-v7a, arm64-v8a, x86, x86_64) and iOS arm64
- `LICENSE`, `PATENTS`, `README.chromium`

## Excluded (not copied)

JPEG/MJPEG: `convert_jpeg.cc`, `mjpeg_decoder.cc`, `mjpeg_validate.cc`

Unused SIMD backends: `*_lsx.cc`, `*_lasx.cc`, `*_hvx.cc`, `*_rvv.cc`, `*_wasm.cc`, `*_sve.cc`, `*_sme.cc`

`*_win.cc` is kept (32-bit x86 SSE lives there).

## Compile defines

`LIBYUV_DISABLE_JPEG`, `LIBYUV_DISABLE_SME`, `LIBYUV_DISABLE_SVE`, `LIBYUV_DISABLE_LSX`, `LIBYUV_DISABLE_LASX`, `LIBYUV_DISABLE_HVX`, `LIBYUV_DISABLE_RVV`

## ISA flags

Only the four `*_neon64.cc` translation units are compiled with `-march=armv8.2-a+dotprod+i8mm` (upstream CMake split). All other SDK and libyuv files stay on the toolchain default ISA. Runtime dispatch in `cpu_id.cc` must be the only path into those kernels.

See `scripts/check-libyuv-isa.sh`.
