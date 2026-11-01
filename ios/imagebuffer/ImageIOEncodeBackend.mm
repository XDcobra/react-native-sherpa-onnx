#import "ImageIOEncodeBackend.h"

#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

#include <cstdio>
#include <string>
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

CFStringRef TypeForFormat(ExportFormat format) {
  switch (format) {
    case ExportFormat::Jpeg:
      return CFSTR("public.jpeg");
    case ExportFormat::Png:
      return CFSTR("public.png");
    case ExportFormat::Heic:
      return CFSTR("public.heic");
    case ExportFormat::Webp:
      break;
  }
  return nullptr;
}

}  // namespace

bool ImageIOEncodeBackend::Supports(ExportFormat format) const {
  return format == ExportFormat::Jpeg || format == ExportFormat::Png ||
         format == ExportFormat::Heic;
}

ExportResult ImageIOEncodeBackend::Encode(const uint8_t* rgb, int width,
                                          int height, const std::string& path,
                                          int quality, ExportFormat format) {
  if (!rgb || width <= 0 || height <= 0) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  if (path.empty()) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "empty output path");
  }
  CFStringRef type = TypeForFormat(format);
  if (!type) {
    return FailEncode("ERR_IMAGE_HW_ENCODER_UNAVAILABLE",
                      "ImageIO does not encode this format");
  }

  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (!cs) {
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "CGColorSpaceCreate");
  }
  const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height);
  std::vector<uint8_t> rgba(n * 4u);
  for (size_t i = 0; i < n; ++i) {
    rgba[i * 4u + 0] = rgb[i * 3u + 0];
    rgba[i * 4u + 1] = rgb[i * 3u + 1];
    rgba[i * 4u + 2] = rgb[i * 3u + 2];
    rgba[i * 4u + 3] = 0xff;
  }
  CGContextRef ctx = CGBitmapContextCreate(
      rgba.data(), static_cast<size_t>(width), static_cast<size_t>(height), 8,
      static_cast<size_t>(width) * 4u, cs,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CFRelease(cs);
  if (!ctx) {
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "CGBitmapContextCreate");
  }
  CGImageRef image = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  if (!image) {
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "CGBitmapContextCreateImage");
  }

  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.c_str()),
      static_cast<CFIndex>(path.size()), false);
  if (!url) {
    CGImageRelease(image);
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "CFURLCreate");
  }
  CGImageDestinationRef dest =
      CGImageDestinationCreateWithURL(url, type, 1, nullptr);
  CFRelease(url);
  if (!dest) {
    CGImageRelease(image);
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "CGImageDestinationCreate");
  }

  const double q = static_cast<double>(quality) / 100.0;
  CFNumberRef qRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberDoubleType, &q);
  const void* keys[] = {kCGImageDestinationLossyCompressionQuality};
  const void* values[] = {qRef};
  CFDictionaryRef props = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, qRef ? 1 : 0,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (qRef) CFRelease(qRef);

  CGImageDestinationAddImage(dest, image, props);
  if (props) CFRelease(props);
  const bool ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  CGImageRelease(image);
  if (!ok) {
    std::remove(path.c_str());
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "CGImageDestinationFinalize");
  }
  ExportResult r;
  r.ok = true;
  return r;
}

}  // namespace image
}  // namespace sherpa_onnx
