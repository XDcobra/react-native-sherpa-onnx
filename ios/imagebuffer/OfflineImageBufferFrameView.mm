#import "OfflineImageBufferFrameView.h"

#include "ImageFrameEncoder.h"
#include "ImageRegistry.h"

#include <mutex>
#include <vector>

@implementation OfflineImageBufferFrameView

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    _frameIndex = 0;
    _maxSide = 0;
    self.contentMode = UIViewContentModeScaleAspectFit;
    self.clipsToBounds = YES;
  }
  return self;
}

- (void)setBufferId:(NSString *)bufferId {
  if (_bufferId == bufferId || [_bufferId isEqualToString:bufferId]) {
    return;
  }
  _bufferId = [bufferId copy];
  [self reloadFrame];
}

- (void)setFrameIndex:(NSInteger)frameIndex {
  NSInteger next = MAX(0, frameIndex);
  if (_frameIndex == next) {
    return;
  }
  _frameIndex = next;
  [self reloadFrame];
}

- (void)setMaxSide:(NSInteger)maxSide {
  if (_maxSide == maxSide) {
    return;
  }
  _maxSide = maxSide;
  [self reloadFrame];
}

- (void)setResizeMode:(NSString *)resizeMode {
  _resizeMode = [resizeMode copy];
  NSString *mode = [resizeMode lowercaseString];
  if ([mode isEqualToString:@"cover"]) {
    self.contentMode = UIViewContentModeScaleAspectFill;
  } else if ([mode isEqualToString:@"stretch"]) {
    self.contentMode = UIViewContentModeScaleToFill;
  } else {
    self.contentMode = UIViewContentModeScaleAspectFit;
  }
}

- (void)reloadFrame {
  if (_bufferId.length == 0) {
    self.image = nil;
    return;
  }

  static std::once_flag once;
  std::call_once(once, []() {
    NSString *cache = [NSTemporaryDirectory() stringByAppendingPathComponent:@"sherpa-image"];
    [[NSFileManager defaultManager] createDirectoryAtPath:cache
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    auto &reg = sherpa_onnx::image::ImageRegistry::Instance();
    reg.SetCacheDir([cache UTF8String]);
    uint64_t ram = [[NSProcessInfo processInfo] physicalMemory];
    reg.ConfigureThreshold(sherpa_onnx::image::ImageThresholdPlatform::Ios, ram);
  });

  sherpa_onnx::image::RgbFrame scratch;
  const uint8_t *rgb = nullptr;
  int width = 0;
  int height = 0;
  if (!sherpa_onnx::image::ResolveFrameRgb([_bufferId UTF8String], (int)_frameIndex,
                                            (int)_maxSide, scratch, &rgb, &width,
                                            &height) ||
      !rgb || width <= 0 || height <= 0) {
    self.image = nil;
    return;
  }

  const size_t pixelCount = static_cast<size_t>(width) * static_cast<size_t>(height);
  std::vector<uint8_t> rgba(pixelCount * 4u);
  for (size_t i = 0; i < pixelCount; ++i) {
    rgba[i * 4u + 0] = rgb[i * 3u + 0];
    rgba[i * 4u + 1] = rgb[i * 3u + 1];
    rgba[i * 4u + 2] = rgb[i * 3u + 2];
    rgba[i * 4u + 3] = 255;
  }

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(
      rgba.data(), width, height, 8, width * 4, colorSpace,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(colorSpace);
  if (!ctx) {
    self.image = nil;
    return;
  }
  CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  if (!cgImage) {
    self.image = nil;
    return;
  }
  self.image = [UIImage imageWithCGImage:cgImage
                                   scale:1.0
                             orientation:UIImageOrientationUp];
  CGImageRelease(cgImage);
}

@end
