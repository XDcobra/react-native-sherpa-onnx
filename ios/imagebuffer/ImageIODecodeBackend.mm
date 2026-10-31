#import "ImageIODecodeBackend.h"

#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

#include "libyuv/convert.h"

#include <vector>

namespace sherpa_onnx {
namespace image {

bool ImageIODecodeBackend::Supports(DecodeFormat format) const {
  return format != DecodeFormat::Unknown;
}

DecodeResult ImageIODecodeBackend::Decode(const uint8_t* data, size_t size,
                                          const DecodeOptions& opts) {
  DecodeResult out;
  CFDataRef cfdata = CFDataCreate(kCFAllocatorDefault, data, (CFIndex)size);
  if (!cfdata) {
    out.errorCode = "ERR_IMAGE_DECODE_FAILED";
    out.errorMessage = "CFDataCreate";
    return out;
  }
  CGImageSourceRef src =
      CGImageSourceCreateWithData(cfdata, nullptr);
  CFRelease(cfdata);
  if (!src) {
    out.errorCode = "ERR_IMAGE_DECODE_FAILED";
    out.errorMessage = "CGImageSource";
    return out;
  }
  CGImageRef image = nullptr;
  if (opts.maxSide > 0) {
    NSDictionary* thumb = @{
      (id)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
      (id)kCGImageSourceCreateThumbnailWithTransform : @YES,
      (id)kCGImageSourceThumbnailMaxPixelSize : @(opts.maxSide),
    };
    image = CGImageSourceCreateThumbnailAtIndex(
        src, 0, (__bridge CFDictionaryRef)thumb);
  } else {
    image = CGImageSourceCreateImageAtIndex(src, 0, nullptr);
  }
  CFRelease(src);
  if (!image) {
    out.errorCode = "ERR_IMAGE_DECODE_FAILED";
    out.errorMessage = "CGImage";
    return out;
  }
  const int w = (int)CGImageGetWidth(image);
  const int h = (int)CGImageGetHeight(image);
  std::vector<uint8_t> rgba(static_cast<size_t>(w) * static_cast<size_t>(h) * 4u);
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(
      rgba.data(), w, h, 8, w * 4, cs,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CFRelease(cs);
  if (!ctx) {
    CGImageRelease(image);
    out.errorCode = "ERR_IMAGE_DECODE_FAILED";
    out.errorMessage = "CGBitmapContext";
    return out;
  }
  CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
  CGContextRelease(ctx);
  CGImageRelease(image);
  out.frame.width = w;
  out.frame.height = h;
  out.frame.rgb.resize(static_cast<size_t>(w) * static_cast<size_t>(h) * 3u);
  libyuv::ABGRToRAW(rgba.data(), w * 4, out.frame.rgb.data(), w * 3, w, h);
  out.ok = out.frame.valid();
  out.format = ImageDecoder::DetectFormat(data, size);
  return out;
}

}  // namespace image
}  // namespace sherpa_onnx
