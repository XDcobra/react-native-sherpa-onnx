#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#include "vendor/stb_image.h"

#include "ImageDecoder.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

#if defined(HAVE_LIBWEBP)
#include <webp/decode.h>
#endif

namespace sherpa_onnx {
namespace image {

namespace {

DecodeResult Fail(const char* code, const std::string& message,
                  DecodeFormat format = DecodeFormat::Unknown) {
  DecodeResult r;
  r.ok = false;
  r.errorCode = code;
  r.errorMessage = message;
  r.format = format;
  return r;
}

bool LooksLikeWebp(const uint8_t* data, size_t size) {
  return size >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' &&
         data[3] == 'F' && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' &&
         data[11] == 'P';
}

bool LooksLikeHeic(const uint8_t* data, size_t size) {
  // ISO BMFF: size(4) + 'ftyp' + brand. HEIC brands: heic, heix, mif1, msf1, hevc, …
  if (size < 12) return false;
  if (!(data[4] == 'f' && data[5] == 't' && data[6] == 'y' && data[7] == 'p')) {
    return false;
  }
  const char brand[5] = {static_cast<char>(data[8]), static_cast<char>(data[9]),
                         static_cast<char>(data[10]), static_cast<char>(data[11]),
                         0};
  return std::strcmp(brand, "heic") == 0 || std::strcmp(brand, "heix") == 0 ||
         std::strcmp(brand, "hevc") == 0 || std::strcmp(brand, "hevx") == 0 ||
         std::strcmp(brand, "mif1") == 0 || std::strcmp(brand, "msf1") == 0;
}

/** Read JPEG EXIF orientation (tag 0x0112). Returns 1..8 or 1 if absent. */
int ReadJpegExifOrientation(const uint8_t* data, size_t size) {
  if (size < 4 || data[0] != 0xFF || data[1] != 0xD8) return 1;

  size_t offset = 2;
  while (offset + 4 <= size) {
    if (data[offset] != 0xFF) break;
    const uint8_t marker = data[offset + 1];
    if (marker == 0xD9 || marker == 0xDA) break;  // EOI / SOS
    if (offset + 4 > size) break;
    const uint16_t segLen =
        static_cast<uint16_t>((data[offset + 2] << 8) | data[offset + 3]);
    if (segLen < 2 || offset + 2 + segLen > size) break;

    if (marker == 0xE1 && segLen >= 8) {
      const uint8_t* app1 = data + offset + 4;
      const size_t app1Len = segLen - 2;
      if (app1Len >= 6 && std::memcmp(app1, "Exif\0\0", 6) == 0) {
        const uint8_t* tiff = app1 + 6;
        const size_t tiffLen = app1Len - 6;
        if (tiffLen < 8) return 1;
        const bool le = tiff[0] == 'I' && tiff[1] == 'I';
        const bool be = tiff[0] == 'M' && tiff[1] == 'M';
        if (!le && !be) return 1;
        auto u16 = [&](size_t o) -> uint16_t {
          if (o + 1 >= tiffLen) return 0;
          return le ? static_cast<uint16_t>(tiff[o] | (tiff[o + 1] << 8))
                    : static_cast<uint16_t>((tiff[o] << 8) | tiff[o + 1]);
        };
        auto u32 = [&](size_t o) -> uint32_t {
          if (o + 3 >= tiffLen) return 0;
          return le ? static_cast<uint32_t>(tiff[o] | (tiff[o + 1] << 8) |
                                            (tiff[o + 2] << 16) | (tiff[o + 3] << 24))
                    : static_cast<uint32_t>((tiff[o] << 24) | (tiff[o + 1] << 16) |
                                            (tiff[o + 2] << 8) | tiff[o + 3]);
        };
        const uint32_t ifd0 = u32(4);
        if (ifd0 + 2 > tiffLen) return 1;
        const uint16_t count = u16(ifd0);
        for (uint16_t i = 0; i < count; ++i) {
          const size_t entry = ifd0 + 2 + static_cast<size_t>(i) * 12;
          if (entry + 12 > tiffLen) break;
          if (u16(entry) == 0x0112) {  // Orientation
            const uint16_t type = u16(entry + 2);
            if (type == 3 /*SHORT*/) {
              const int orient = static_cast<int>(u16(entry + 8));
              if (orient >= 1 && orient <= 8) return orient;
            }
            return 1;
          }
        }
      }
      return 1;
    }
    offset += 2 + segLen;
  }
  return 1;
}

void SetPixel(std::vector<uint8_t>& rgb, int w, int x, int y, const uint8_t* px) {
  const size_t i = (static_cast<size_t>(y) * static_cast<size_t>(w) + static_cast<size_t>(x)) * 3u;
  rgb[i] = px[0];
  rgb[i + 1] = px[1];
  rgb[i + 2] = px[2];
}

const uint8_t* GetPixel(const std::vector<uint8_t>& rgb, int w, int x, int y) {
  return rgb.data() +
         (static_cast<size_t>(y) * static_cast<size_t>(w) + static_cast<size_t>(x)) * 3u;
}

}  // namespace

DecodeFormat ImageDecoder::DetectFormat(const uint8_t* data, size_t size) {
  if (!data || size < 4) return DecodeFormat::Unknown;
  if (data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) return DecodeFormat::Jpeg;
  if (size >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G') {
    return DecodeFormat::Png;
  }
  if (data[0] == 'B' && data[1] == 'M') return DecodeFormat::Bmp;
  if (size >= 6 && data[0] == 'G' && data[1] == 'I' && data[2] == 'F') return DecodeFormat::Gif;
  if (LooksLikeWebp(data, size)) return DecodeFormat::Webp;
  if (LooksLikeHeic(data, size)) return DecodeFormat::Heic;
  return DecodeFormat::Unknown;
}

int ImageDecoder::ApplyExifOrientation(RgbFrame& frame, int orientation) {
  if (!frame.valid() || orientation <= 1 || orientation > 8) return 1;

  const int w = frame.width;
  const int h = frame.height;
  const auto& src = frame.rgb;
  std::vector<uint8_t> dst;
  int nw = w;
  int nh = h;

  auto needsSwap = orientation >= 5;
  if (needsSwap) {
    nw = h;
    nh = w;
  }
  dst.assign(static_cast<size_t>(nw) * static_cast<size_t>(nh) * 3u, 0);

  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const uint8_t* px = GetPixel(src, w, x, y);
      int dx = x;
      int dy = y;
      switch (orientation) {
        case 2:  // mirror horizontal
          dx = w - 1 - x;
          dy = y;
          break;
        case 3:  // rotate 180
          dx = w - 1 - x;
          dy = h - 1 - y;
          break;
        case 4:  // mirror vertical
          dx = x;
          dy = h - 1 - y;
          break;
        case 5:  // mirror horizontal + rotate 270 CW
          dx = y;
          dy = x;
          break;
        case 6:  // rotate 90 CW
          dx = h - 1 - y;
          dy = x;
          break;
        case 7:  // mirror horizontal + rotate 90 CW
          dx = h - 1 - y;
          dy = w - 1 - x;
          break;
        case 8:  // rotate 270 CW
          dx = y;
          dy = w - 1 - x;
          break;
        default:
          break;
      }
      SetPixel(dst, nw, dx, dy, px);
    }
  }

  frame.width = nw;
  frame.height = nh;
  frame.rgb = std::move(dst);
  return orientation;
}

float ImageDecoder::ApplyMaxSide(RgbFrame& frame, int maxSide) {
  if (!frame.valid() || maxSide <= 0) return 1.f;
  const int longest = std::max(frame.width, frame.height);
  if (longest <= maxSide) return 1.f;

  const float scale = static_cast<float>(maxSide) / static_cast<float>(longest);
  const int nw = std::max(1, static_cast<int>(std::lround(frame.width * scale)));
  const int nh = std::max(1, static_cast<int>(std::lround(frame.height * scale)));

  std::vector<uint8_t> dst(static_cast<size_t>(nw) * static_cast<size_t>(nh) * 3u);
  // Bilinear downsample
  for (int y = 0; y < nh; ++y) {
    const float sy = (y + 0.5f) * static_cast<float>(frame.height) / static_cast<float>(nh) - 0.5f;
    const int y0 = std::max(0, static_cast<int>(std::floor(sy)));
    const int y1 = std::min(frame.height - 1, y0 + 1);
    const float fy = sy - static_cast<float>(y0);
    for (int x = 0; x < nw; ++x) {
      const float sx = (x + 0.5f) * static_cast<float>(frame.width) / static_cast<float>(nw) - 0.5f;
      const int x0 = std::max(0, static_cast<int>(std::floor(sx)));
      const int x1 = std::min(frame.width - 1, x0 + 1);
      const float fx = sx - static_cast<float>(x0);
      for (int c = 0; c < 3; ++c) {
        const float v00 = GetPixel(frame.rgb, frame.width, x0, y0)[c];
        const float v10 = GetPixel(frame.rgb, frame.width, x1, y0)[c];
        const float v01 = GetPixel(frame.rgb, frame.width, x0, y1)[c];
        const float v11 = GetPixel(frame.rgb, frame.width, x1, y1)[c];
        const float v0 = v00 + (v10 - v00) * fx;
        const float v1 = v01 + (v11 - v01) * fx;
        const float v = v0 + (v1 - v0) * fy;
        dst[(static_cast<size_t>(y) * static_cast<size_t>(nw) + static_cast<size_t>(x)) * 3u +
            static_cast<size_t>(c)] = static_cast<uint8_t>(std::clamp(std::lround(v), 0L, 255L));
      }
    }
  }

  frame.width = nw;
  frame.height = nh;
  frame.rgb = std::move(dst);
  return scale;
}

DecodeResult ImageDecoder::DecodeBytes(const uint8_t* data, size_t size,
                                       const DecodeOptions& opts) {
  if (!data || size == 0) {
    return Fail("ERR_IMAGE_DECODE_FAILED", "empty image bytes");
  }

  const DecodeFormat format = DetectFormat(data, size);
  if (format == DecodeFormat::Heic) {
    return Fail("ERR_IMAGE_FORMAT_UNSUPPORTED",
                "HEIC requires platform decoder (ImageIO / ImageDecoder)", format);
  }

  RgbFrame frame;
  int orientation = 1;

  if (format == DecodeFormat::Webp) {
#if defined(HAVE_LIBWEBP)
    int w = 0;
    int h = 0;
    uint8_t* decoded = WebPDecodeRGB(data, size, &w, &h);
    if (!decoded || w <= 0 || h <= 0) {
      if (decoded) WebPFree(decoded);
      return Fail("ERR_IMAGE_DECODE_FAILED", "libwebp decode failed", format);
    }
    frame.width = w;
    frame.height = h;
    frame.rgb.assign(decoded, decoded + static_cast<size_t>(w) * static_cast<size_t>(h) * 3u);
    WebPFree(decoded);
#else
    return Fail("ERR_IMAGE_WEBP_DISABLED",
                "libwebp is not linked. Rebuild with sherpaOnnxEnableLibwebp=true "
                "(Android) or SHERPA_ONNX_ENABLE_LIBWEBP=1 (iOS) and ensure libwebp "
                "prebuilts resolve.",
                format);
#endif
  } else {
    int w = 0;
    int h = 0;
    int comp = 0;
    unsigned char* pixels =
        stbi_load_from_memory(data, static_cast<int>(size), &w, &h, &comp, 3);
    if (!pixels || w <= 0 || h <= 0) {
      return Fail("ERR_IMAGE_DECODE_FAILED",
                  stbi_failure_reason() ? stbi_failure_reason() : "stb_image failed",
                  format);
    }
    frame.width = w;
    frame.height = h;
    frame.rgb.assign(pixels, pixels + static_cast<size_t>(w) * static_cast<size_t>(h) * 3u);
    stbi_image_free(pixels);

    if (format == DecodeFormat::Jpeg) {
      orientation = ReadJpegExifOrientation(data, size);
      orientation = ApplyExifOrientation(frame, orientation);
    }
  }

  if (!frame.valid()) {
    return Fail("ERR_IMAGE_DECODE_FAILED", "invalid RGB frame after decode", format);
  }

  const float scale = ApplyMaxSide(frame, opts.maxSide);

  DecodeResult out;
  out.ok = true;
  out.format = format == DecodeFormat::Unknown ? DecodeFormat::Jpeg : format;
  out.orientationApplied = orientation;
  out.scaleApplied = scale;
  out.frame = std::move(frame);
  return out;
}

DecodeResult ImageDecoder::DecodeFile(const std::string& path, const DecodeOptions& opts) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    return Fail("ERR_IMAGE_DECODE_FAILED", "cannot open file: " + path);
  }
  in.seekg(0, std::ios::end);
  const auto len = in.tellg();
  if (len <= 0) {
    return Fail("ERR_IMAGE_DECODE_FAILED", "empty file: " + path);
  }
  in.seekg(0, std::ios::beg);
  std::vector<uint8_t> buf(static_cast<size_t>(len));
  if (!in.read(reinterpret_cast<char*>(buf.data()), len)) {
    return Fail("ERR_IMAGE_DECODE_FAILED", "read failed: " + path);
  }
  return DecodeBytes(buf.data(), buf.size(), opts);
}

}  // namespace image
}  // namespace sherpa_onnx
