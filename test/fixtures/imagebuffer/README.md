# ImageBuffer host-test fixtures

Small committed images for `imagebuffer_host_test` (C++ GTest).

| File | Purpose |
| --- | --- |
| `solid_red_64x48.jpg` | JPEG decode / multi-file create |
| `solid_blue_64x48.png` | PNG decode |
| `solid_red_64x48.webp` | WebP decode (requires `HAVE_LIBWEBP`) |
| `exif_orient6_40x20.jpg` | JPEG with EXIF Orientation=6 (asymmetric blue strip) |
| `green_512x256.jpg` | `maxSide` downscale |

Large mmap cases do **not** use fixtures — tests build synthetic `RgbFrame`s in memory.

## Regenerate

```bash
magick -size 64x48 xc:'#e11d48' -quality 90 test/fixtures/imagebuffer/solid_red_64x48.jpg
magick -size 64x48 xc:'#2563eb' test/fixtures/imagebuffer/solid_blue_64x48.png
cwebp -q 80 test/fixtures/imagebuffer/solid_red_64x48.jpg \
  -o test/fixtures/imagebuffer/solid_red_64x48.webp
magick -size 512x256 xc:'#16a34a' -quality 85 test/fixtures/imagebuffer/green_512x256.jpg
# EXIF Orientation=6 is injected by the test-authoring script (APP1 Exif); do not
# overwrite exif_orient6_40x20.jpg with plain magick unless you re-inject APP1.
```

## HEIC manual smoke (not in CI)

HEIC is platform-only (Android `ImageDecoder` API 28+, iOS ImageIO). On a device/emulator:

1. Call `createOfflineImageBufferFromFiles` with a `.heic` `FileSource`.
2. Expect `frameCount >= 1`, non-zero width/height.
3. Confirm WebP works with `sherpaOnnxEnableLibwebp=true` / `SHERPA_ONNX_ENABLE_LIBWEBP=1`; without enable expect `ERR_IMAGE_WEBP_DISABLED`.
