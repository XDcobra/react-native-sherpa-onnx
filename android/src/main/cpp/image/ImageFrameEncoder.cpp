#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "decode/vendor/stb_image_write.h"

#include "ImageFrameEncoder.h"

#include "ImageRegistry.h"
#include "decode/ImageDecoder.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <fstream>

#if defined(HAVE_LIBWEBP)
#include <webp/encode.h>
#endif

namespace sherpa_onnx {
namespace image {

namespace {

ExportResult Fail(const char* code, const std::string& message) {
  ExportResult r;
  r.ok = false;
  r.errorCode = code;
  r.errorMessage = message;
  return r;
}

ExportResult Ok() {
  ExportResult r;
  r.ok = true;
  return r;
}

std::string ToLower(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

int ClampQuality(int q) {
  if (q < 1) return 1;
  if (q > 100) return 100;
  return q;
}

bool WriteBytesToFile(const std::string& path, const uint8_t* data, size_t size) {
  if (!data || size == 0) return false;
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) return false;
  out.write(reinterpret_cast<const char*>(data),
            static_cast<std::streamsize>(size));
  return static_cast<bool>(out);
}

/** Streams stb write chunks straight to disk (no full encoded buffer). */
struct StbStreamCtx {
  std::ofstream* out = nullptr;
  bool ok = true;
};

void StbStreamCallback(void* context, void* data, int size) {
  auto* ctx = static_cast<StbStreamCtx*>(context);
  if (!ctx || !ctx->out || !ctx->ok || !data || size <= 0) return;
  ctx->out->write(reinterpret_cast<const char*>(data),
                  static_cast<std::streamsize>(size));
  if (!*ctx->out) ctx->ok = false;
}

}  // namespace

bool ParseExportFormat(const std::string& name, ExportFormat* out) {
  if (!out) return false;
  const std::string n = ToLower(name);
  if (n == "jpeg" || n == "jpg") {
    *out = ExportFormat::Jpeg;
    return true;
  }
  if (n == "png") {
    *out = ExportFormat::Png;
    return true;
  }
  if (n == "webp") {
    *out = ExportFormat::Webp;
    return true;
  }
  return false;
}

bool CopyFrameRgb(const std::string& bufferId, int frameIndex, int maxSide,
                  RgbFrame& out) {
  int w = 0;
  int h = 0;
  const uint8_t* ptr =
      ImageRegistry::Instance().GetFrameRgbPtr(bufferId, frameIndex, &w, &h);
  if (!ptr || w <= 0 || h <= 0) {
    return false;
  }
  out.width = w;
  out.height = h;
  out.rgb.assign(ptr, ptr + static_cast<size_t>(w) * static_cast<size_t>(h) * 3u);
  ImageDecoder::ApplyMaxSide(out, maxSide);
  return out.valid();
}

bool ResolveFrameRgb(const std::string& bufferId, int frameIndex, int maxSide,
                     RgbFrame& scratch, const uint8_t** outPtr, int* outW,
                     int* outH) {
  if (!outPtr || !outW || !outH) return false;
  *outPtr = nullptr;
  *outW = 0;
  *outH = 0;

  if (maxSide > 0) {
    if (!CopyFrameRgb(bufferId, frameIndex, maxSide, scratch)) return false;
    *outPtr = scratch.rgb.data();
    *outW = scratch.width;
    *outH = scratch.height;
    return true;
  }

  int w = 0;
  int h = 0;
  const uint8_t* ptr =
      ImageRegistry::Instance().GetFrameRgbPtr(bufferId, frameIndex, &w, &h);
  if (!ptr || w <= 0 || h <= 0) return false;
  *outPtr = ptr;
  *outW = w;
  *outH = h;
  return true;
}

void FillArgb8888FromRgb(const uint8_t* rgb, int width, int height,
                         uint32_t* destArgb) {
  if (!rgb || !destArgb || width <= 0 || height <= 0) return;
  const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height);
  for (size_t i = 0; i < n; ++i) {
    const uint8_t r = rgb[i * 3u + 0];
    const uint8_t g = rgb[i * 3u + 1];
    const uint8_t b = rgb[i * 3u + 2];
    destArgb[i] = (0xffu << 24) | (static_cast<uint32_t>(r) << 16) |
                  (static_cast<uint32_t>(g) << 8) | static_cast<uint32_t>(b);
  }
}

ExportResult EncodeRgbBytesToFile(const uint8_t* rgb, int width, int height,
                                  const std::string& outPath,
                                  const ExportOptions& opts) {
  if (!rgb || width <= 0 || height <= 0) {
    return Fail("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  if (outPath.empty()) {
    return Fail("ERR_IMAGE_INVALID_ARGUMENT", "empty output path");
  }

  const int quality = ClampQuality(opts.quality);
  const int stride = width * 3;

  switch (opts.format) {
    case ExportFormat::Jpeg: {
      std::ofstream out(outPath, std::ios::binary | std::ios::trunc);
      if (!out) {
        return Fail("ERR_IMAGE_ENCODE_FAILED", "failed to open JPEG file");
      }
      StbStreamCtx ctx;
      ctx.out = &out;
      const int ok = stbi_write_jpg_to_func(StbStreamCallback, &ctx, width,
                                           height, 3, rgb, quality);
      if (!ok || !ctx.ok || !out) {
        out.close();
        std::remove(outPath.c_str());
        return Fail("ERR_IMAGE_ENCODE_FAILED", "JPEG encode failed");
      }
      return Ok();
    }
    case ExportFormat::Png: {
      std::ofstream out(outPath, std::ios::binary | std::ios::trunc);
      if (!out) {
        return Fail("ERR_IMAGE_ENCODE_FAILED", "failed to open PNG file");
      }
      StbStreamCtx ctx;
      ctx.out = &out;
      const int ok = stbi_write_png_to_func(StbStreamCallback, &ctx, width,
                                           height, 3, rgb, stride);
      if (!ok || !ctx.ok || !out) {
        out.close();
        std::remove(outPath.c_str());
        return Fail("ERR_IMAGE_ENCODE_FAILED", "PNG encode failed");
      }
      return Ok();
    }
    case ExportFormat::Webp: {
#if defined(HAVE_LIBWEBP)
      // libwebp returns one contiguous buffer; no chunked file API in our path.
      uint8_t* encoded = nullptr;
      const size_t encodedSize = WebPEncodeRGB(
          rgb, width, height, stride, static_cast<float>(quality), &encoded);
      if (encodedSize == 0 || !encoded) {
        return Fail("ERR_IMAGE_ENCODE_FAILED", "WebP encode failed");
      }
      const bool written = WriteBytesToFile(outPath, encoded, encodedSize);
      WebPFree(encoded);
      if (!written) {
        return Fail("ERR_IMAGE_ENCODE_FAILED", "failed to write WebP file");
      }
      return Ok();
#else
      return Fail("ERR_IMAGE_FORMAT_UNSUPPORTED",
                  "WebP support disabled (libwebp not linked)");
#endif
    }
  }
  return Fail("ERR_IMAGE_INVALID_ARGUMENT", "unknown export format");
}

ExportResult EncodeRgbFrameToFile(const RgbFrame& frame,
                                  const std::string& outPath,
                                  const ExportOptions& opts) {
  if (!frame.valid()) {
    return Fail("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  return EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height,
                              outPath, opts);
}

ExportResult ExportFrameToFile(const std::string& bufferId, int frameIndex,
                               const std::string& outPath,
                               const ExportOptions& opts) {
  RgbFrame scratch;
  const uint8_t* ptr = nullptr;
  int w = 0;
  int h = 0;
  if (!ResolveFrameRgb(bufferId, frameIndex, opts.maxSide, scratch, &ptr, &w,
                       &h)) {
    return Fail("ERR_IMAGE_BUFFER_NOT_FOUND", "frame not found");
  }
  return EncodeRgbBytesToFile(ptr, w, h, outPath, opts);
}

}  // namespace image
}  // namespace sherpa_onnx
