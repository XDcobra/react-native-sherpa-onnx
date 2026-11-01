#include "ImageFrameEncoder.h"

#include "ImageRegistry.h"
#include "decode/ImageDecoder.h"
#include "encode/ImageEncodeBackend.h"

#include <algorithm>
#include <cctype>
#include <cstring>

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

std::string ToLower(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
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
  if (n == "heic" || n == "heif") {
    *out = ExportFormat::Heic;
    return true;
  }
  return false;
}

const char* ExportFormatName(ExportFormat format) {
  switch (format) {
    case ExportFormat::Jpeg:
      return "jpeg";
    case ExportFormat::Png:
      return "png";
    case ExportFormat::Webp:
      return "webp";
    case ExportFormat::Heic:
      return "heic";
  }
  return "jpeg";
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
  return EncodeRgbBytesWithPolicy(rgb, width, height, outPath, opts);
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
