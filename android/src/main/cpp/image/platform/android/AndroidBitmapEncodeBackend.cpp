#ifdef __ANDROID__

// minSdk 24 + NDK 29 marks AndroidBitmap_compress (API 30) hard-unavailable.
// Weak imports keep the .so loadable on API 24–29.
#ifndef __ANDROID_UNAVAILABLE_SYMBOLS_ARE_WEAK__
#define __ANDROID_UNAVAILABLE_SYMBOLS_ARE_WEAK__
#endif

#include "platform/android/AndroidBitmapEncodeBackend.h"

#include <android/bitmap.h>
#include <android/data_space.h>

#include <cstdio>
#include <fstream>
#include <vector>

namespace sherpa_onnx {
namespace image {
namespace {

ExportResult FailEncode(const char* code, const std::string& message) {
  ExportResult r;
  r.ok = false;
  r.errorCode = code;
  r.errorMessage = message;
  return r;
}

struct CompressCtx {
  std::ofstream* out = nullptr;
  bool ok = true;
};

bool CompressWrite(void* userContext, const void* data, size_t size) {
  auto* ctx = static_cast<CompressCtx*>(userContext);
  if (!ctx || !ctx->out || !ctx->ok) return false;
  if (!data || size == 0) return true;
  ctx->out->write(reinterpret_cast<const char*>(data),
                  static_cast<std::streamsize>(size));
  if (!*ctx->out) {
    ctx->ok = false;
    return false;
  }
  return true;
}

void FillRgba8888FromRgb(const uint8_t* rgb, int width, int height,
                         uint8_t* rgba) {
  const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height);
  for (size_t i = 0; i < n; ++i) {
    rgba[i * 4u + 0] = rgb[i * 3u + 0];
    rgba[i * 4u + 1] = rgb[i * 3u + 1];
    rgba[i * 4u + 2] = rgb[i * 3u + 2];
    rgba[i * 4u + 3] = 0xff;
  }
}

int32_t CompressFormatFor(ExportFormat format) {
  switch (format) {
    case ExportFormat::Jpeg:
      return ANDROID_BITMAP_COMPRESS_FORMAT_JPEG;
    case ExportFormat::Png:
      return ANDROID_BITMAP_COMPRESS_FORMAT_PNG;
    case ExportFormat::Webp:
      return ANDROID_BITMAP_COMPRESS_FORMAT_WEBP_LOSSY;
    case ExportFormat::Heic:
      break;
  }
  return -1;
}

}  // namespace

bool AndroidBitmapCompressAvailable() {
  if (__builtin_available(android 30, *)) {
    return true;
  }
  return false;
}

bool AndroidBitmapEncodeBackend::Supports(ExportFormat format) const {
  return format == ExportFormat::Jpeg || format == ExportFormat::Png ||
         format == ExportFormat::Webp;
}

ExportResult AndroidBitmapEncodeBackend::Encode(const uint8_t* rgb, int width,
                                                int height,
                                                const std::string& path,
                                                int quality,
                                                ExportFormat format) {
  if (!rgb || width <= 0 || height <= 0) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  if (path.empty()) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "empty output path");
  }
  const int32_t compressFormat = CompressFormatFor(format);
  if (compressFormat < 0) {
    return FailEncode("ERR_IMAGE_HW_ENCODER_UNAVAILABLE",
                      "AndroidBitmap_compress does not encode this format");
  }
  if (!AndroidBitmapCompressAvailable()) {
    return FailEncode("ERR_IMAGE_HW_ENCODER_UNAVAILABLE", "os-too-old");
  }

  if (__builtin_available(android 30, *)) {
    std::vector<uint8_t> rgba(static_cast<size_t>(width) *
                              static_cast<size_t>(height) * 4u);
    FillRgba8888FromRgb(rgb, width, height, rgba.data());

    AndroidBitmapInfo info{};
    info.width = static_cast<uint32_t>(width);
    info.height = static_cast<uint32_t>(height);
    info.stride = static_cast<uint32_t>(width) * 4u;
    info.format = ANDROID_BITMAP_FORMAT_RGBA_8888;
    info.flags = ANDROID_BITMAP_FLAGS_ALPHA_OPAQUE;

    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) {
      return FailEncode("ERR_IMAGE_ENCODE_FAILED",
                        "failed to open AndroidBitmap output");
    }
    CompressCtx ctx;
    ctx.out = &out;
    const int rc = AndroidBitmap_compress(
        &info, ADATASPACE_SRGB, rgba.data(), compressFormat, quality, &ctx,
        CompressWrite);
    if (rc != ANDROID_BITMAP_RESULT_SUCCESS || !ctx.ok || !out) {
      out.close();
      std::remove(path.c_str());
      return FailEncode("ERR_IMAGE_ENCODE_FAILED",
                        "AndroidBitmap_compress failed");
    }
    ExportResult ok;
    ok.ok = true;
    return ok;
  }

  return FailEncode("ERR_IMAGE_HW_ENCODER_UNAVAILABLE", "os-too-old");
}

}  // namespace image
}  // namespace sherpa_onnx

#endif
