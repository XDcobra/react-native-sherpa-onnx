#import "SherpaOnnx.h"
#import "../fileio/FileIOResolver.h"

#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>

#include "ImageFrameEncoder.h"
#include "ImageRegistry.h"
#include "decode/ImageDecoder.h"

#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

using sherpa_onnx::image::DecodeOptions;
using sherpa_onnx::image::ImageDecoder;
using sherpa_onnx::image::ImageRegistry;
using sherpa_onnx::image::ImageThresholdPathType;
using sherpa_onnx::image::ImageThresholdPlatform;
using sherpa_onnx::image::RgbFrame;

namespace {

std::mutex gCancelMu;
std::unordered_map<std::string, bool> gCancelFlags;

bool IsCancelled(NSString *operationId) {
  if (operationId.length == 0) return false;
  std::lock_guard<std::mutex> lock(gCancelMu);
  auto it = gCancelFlags.find([operationId UTF8String]);
  return it != gCancelFlags.end() && it->second;
}

void SetCancel(NSString *operationId, bool value) {
  if (operationId.length == 0) return;
  std::lock_guard<std::mutex> lock(gCancelMu);
  if (value) {
    gCancelFlags[[operationId UTF8String]] = true;
  } else {
    gCancelFlags.erase([operationId UTF8String]);
  }
}

void EnsureImageRegistryInit() {
  static std::once_flag once;
  std::call_once(once, []() {
    NSString *cache = [NSTemporaryDirectory() stringByAppendingPathComponent:@"sherpa-image"];
    [[NSFileManager defaultManager] createDirectoryAtPath:cache
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    auto &reg = ImageRegistry::Instance();
    reg.SetCacheDir([cache UTF8String]);
    uint64_t ram = [[NSProcessInfo processInfo] physicalMemory];
    reg.ConfigureThreshold(ImageThresholdPlatform::Ios, ram);
    reg.SweepOrphanedTempFiles();
  });
}

NSDictionary *InfoDict(const sherpa_onnx::image::ImageBufferInfo &info) {
  return @{
    @"bufferId" : [NSString stringWithUTF8String:info.bufferId.c_str()],
    @"kind" : @"offlineImageBuffer",
    @"state" : @"immutable",
    @"frameCount" : @(info.frameCount),
    @"totalBytes" : @(info.totalBytes),
    @"storageKind" :
        [NSString stringWithUTF8String:sherpa_onnx::image::StorageKindName(info.storageKind)],
  };
}

void EmitProgress(SherpaOnnx *bridge, NSString *operationId, int done, int total,
                  NSString *phase) {
  if (operationId.length == 0 || bridge == nil) return;
  [bridge sendEventWithName:@"SherpaOnnxImageProgress"
                       body:@{
                         @"operationId" : operationId,
                         @"done" : @(done),
                         @"total" : @(total),
                         @"phase" : phase ?: @"decode",
                       }];
}

bool LooksLikeHeicBytes(const uint8_t *data, size_t size) {
  return ImageDecoder::DetectFormat(data, size) == sherpa_onnx::image::DecodeFormat::Heic;
}

bool DecodeHeicToRgb(NSData *data, int maxSide, RgbFrame &out, NSString **errOut) {
  CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)data, nullptr);
  if (!src) {
    if (errOut) *errOut = @"CGImageSourceCreateWithData failed";
    return false;
  }
  CGImageRef image = CGImageSourceCreateImageAtIndex(src, 0, nullptr);
  CFRelease(src);
  if (!image) {
    if (errOut) *errOut = @"CGImageSourceCreateImageAtIndex failed";
    return false;
  }

  size_t w = CGImageGetWidth(image);
  size_t h = CGImageGetHeight(image);
  if (maxSide > 0) {
    size_t longest = w > h ? w : h;
    if ((int)longest > maxSide) {
      double scale = (double)maxSide / (double)longest;
      size_t nw = (size_t)llround(w * scale);
      size_t nh = (size_t)llround(h * scale);
      if (nw < 1) nw = 1;
      if (nh < 1) nh = 1;
      CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
      CGContextRef ctx = CGBitmapContextCreate(
          nullptr, nw, nh, 8, nw * 4, cs,
          kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
      CGColorSpaceRelease(cs);
      if (!ctx) {
        CGImageRelease(image);
        if (errOut) *errOut = @"CGBitmapContextCreate failed";
        return false;
      }
      CGContextDrawImage(ctx, CGRectMake(0, 0, nw, nh), image);
      CGImageRelease(image);
      image = CGBitmapContextCreateImage(ctx);
      CGContextRelease(ctx);
      w = nw;
      h = nh;
      if (!image) {
        if (errOut) *errOut = @"scaled CGImage create failed";
        return false;
      }
    }
  }

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  std::vector<uint8_t> rgba(w * h * 4);
  CGContextRef ctx = CGBitmapContextCreate(
      rgba.data(), w, h, 8, w * 4, colorSpace,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(colorSpace);
  if (!ctx) {
    CGImageRelease(image);
    if (errOut) *errOut = @"RGBA context failed";
    return false;
  }
  CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
  CGContextRelease(ctx);
  CGImageRelease(image);

  out.width = (int)w;
  out.height = (int)h;
  out.rgb.resize(w * h * 3);
  for (size_t i = 0, j = 0; i < w * h; ++i, j += 3) {
    out.rgb[j] = rgba[i * 4];
    out.rgb[j + 1] = rgba[i * 4 + 1];
    out.rgb[j + 2] = rgba[i * 4 + 2];
  }
  return true;
}

bool AppendBytes(const std::string &bufferId, NSData *data, int maxSide, bool fileOrigin,
                 NSString **errOut) {
  const auto *bytes = (const uint8_t *)data.bytes;
  const size_t size = (size_t)data.length;
  auto pathType = fileOrigin ? ImageThresholdPathType::FileOrigin
                             : ImageThresholdPathType::HeapOrigin;

  if (LooksLikeHeicBytes(bytes, size)) {
    RgbFrame frame;
    NSString *heicErr = nil;
    if (!DecodeHeicToRgb(data, maxSide, frame, &heicErr)) {
      if (errOut) *errOut = heicErr ?: @"HEIC decode failed";
      return false;
    }
    if (!ImageRegistry::Instance().AppendRgbFrame(bufferId, std::move(frame), pathType)) {
      if (errOut) *errOut = @"appendRgb failed";
      return false;
    }
    return true;
  }

  DecodeOptions opts;
  opts.maxSide = maxSide;
  auto decoded = ImageDecoder::DecodeBytes(bytes, size, opts);
  if (!decoded.ok) {
    if (errOut) {
      *errOut = [NSString stringWithFormat:@"%s: %s", decoded.errorCode.c_str(),
                                           decoded.errorMessage.c_str()];
    }
    return false;
  }
  if (!ImageRegistry::Instance().AppendRgbFrame(bufferId, std::move(decoded.frame), pathType)) {
    if (errOut) *errOut = @"append after decode failed";
    return false;
  }
  return true;
}

int MaxSideFromOptions(NSDictionary *options) {
  if (options[@"maxSide"] != nil) return [options[@"maxSide"] intValue];
  return 4096;
}

}  // namespace

@implementation SherpaOnnx (ImageBuffer)

- (void)createEmptyOfflineImageBuffer:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  std::string id = ImageRegistry::Instance().CreateEmpty();
  sherpa_onnx::image::ImageBufferInfo info;
  ImageRegistry::Instance().GetInfo(id, info);
  resolve(InfoDict(info));
}

- (void)createOfflineImageBufferFromFiles:(NSArray *)sources
                                  options:(NSDictionary *)options
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  if (sources.count == 0) {
    reject(@"ERR_IMAGE_INVALID_ARGUMENT", @"sources required", nil);
    return;
  }
  int maxSide = MaxSideFromOptions(options);
  NSString *operationId = options[@"operationId"];
  if (operationId.length > 0) SetCancel(operationId, false);

  std::string bufferId = ImageRegistry::Instance().CreateEmpty();
  NSInteger total = sources.count;
  for (NSInteger i = 0; i < total; ++i) {
    if (IsCancelled(operationId)) {
      ImageRegistry::Instance().Release(bufferId);
      SetCancel(operationId, false);
      reject(@"ERR_IMAGE_CANCELLED", @"cancelled", nil);
      return;
    }
    EmitProgress(self, operationId, (int)i, (int)total, @"decode");

    id item = sources[i];
    if (![item isKindOfClass:[NSDictionary class]]) {
      ImageRegistry::Instance().Release(bufferId);
      reject(@"ERR_IMAGE_INVALID_ARGUMENT",
             [NSString stringWithFormat:@"source[%ld] must be a FileSource map", (long)i], nil);
      return;
    }
    NSDictionary *source = (NSDictionary *)item;
    NSString *errCode = nil;
    NSString *errMsg = nil;
    FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source
                                                           error:&errCode
                                                         message:&errMsg];
    if (!readHandle) {
      ImageRegistry::Instance().Release(bufferId);
      reject(errCode ?: @"ERR_IMAGE_DECODE_FAILED", errMsg ?: @"Failed to resolve FileSource", nil);
      return;
    }

    NSData *data = nil;
    if (readHandle.isFilePath && readHandle.filePath.length > 0) {
      data = [NSData dataWithContentsOfFile:readHandle.filePath];
    } else if (readHandle.stream != nil) {
      [readHandle.stream open];
      NSMutableData *buf = [NSMutableData data];
      uint8_t chunk[65536];
      NSInteger n;
      while ((n = [readHandle.stream read:chunk maxLength:sizeof(chunk)]) > 0) {
        [buf appendBytes:chunk length:(NSUInteger)n];
      }
      data = buf;
    }
    [readHandle cleanup];

    if (!data || data.length == 0) {
      ImageRegistry::Instance().Release(bufferId);
      reject(@"ERR_IMAGE_DECODE_FAILED", @"empty or unreadable FileSource", nil);
      return;
    }
    NSString *err = nil;
    if (!AppendBytes(bufferId, data, maxSide, true, &err)) {
      ImageRegistry::Instance().Release(bufferId);
      reject(@"ERR_IMAGE_DECODE_FAILED", err ?: @"decode failed", nil);
      return;
    }
  }
  EmitProgress(self, operationId, (int)total, (int)total, @"done");
  ImageRegistry::Instance().MaybeUpgradeToMmap(bufferId, ImageThresholdPathType::FileOrigin);
  sherpa_onnx::image::ImageBufferInfo info;
  ImageRegistry::Instance().GetInfo(bufferId, info);
  SetCancel(operationId, false);
  resolve(InfoDict(info));
}

- (void)createOfflineImageBufferFromBase64:(NSArray *)base64List
                                   options:(NSDictionary *)options
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  if (base64List.count == 0) {
    reject(@"ERR_IMAGE_INVALID_ARGUMENT", @"no blobs", nil);
    return;
  }
  int maxSide = MaxSideFromOptions(options);
  NSString *operationId = options[@"operationId"];
  if (operationId.length > 0) SetCancel(operationId, false);

  std::string bufferId = ImageRegistry::Instance().CreateEmpty();
  NSInteger total = base64List.count;
  for (NSInteger i = 0; i < total; ++i) {
    if (IsCancelled(operationId)) {
      ImageRegistry::Instance().Release(bufferId);
      SetCancel(operationId, false);
      reject(@"ERR_IMAGE_CANCELLED", @"cancelled", nil);
      return;
    }
    EmitProgress(self, operationId, (int)i, (int)total, @"decode");
    NSString *b64 = [base64List[i] description];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
    if (!data) {
      ImageRegistry::Instance().Release(bufferId);
      reject(@"ERR_IMAGE_DECODE_FAILED", @"invalid base64", nil);
      return;
    }
    NSString *err = nil;
    if (!AppendBytes(bufferId, data, maxSide, false, &err)) {
      ImageRegistry::Instance().Release(bufferId);
      reject(@"ERR_IMAGE_DECODE_FAILED", err ?: @"decode failed", nil);
      return;
    }
  }
  EmitProgress(self, operationId, (int)total, (int)total, @"done");
  ImageRegistry::Instance().MaybeUpgradeToMmap(bufferId, ImageThresholdPathType::HeapOrigin);
  sherpa_onnx::image::ImageBufferInfo info;
  ImageRegistry::Instance().GetInfo(bufferId, info);
  SetCancel(operationId, false);
  resolve(InfoDict(info));
}

- (void)getOfflineImageBufferInfo:(NSString *)bufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  sherpa_onnx::image::ImageBufferInfo info;
  if (!ImageRegistry::Instance().GetInfo([bufferId UTF8String], info)) {
    reject(@"ERR_IMAGE_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Image buffer not found: %@", bufferId], nil);
    return;
  }
  resolve(InfoDict(info));
}

- (void)getOfflineImageBufferFrameInfo:(NSString *)bufferId
                            frameIndex:(double)frameIndex
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  sherpa_onnx::image::ImageFrameInfo info;
  if (!ImageRegistry::Instance().GetFrameInfo([bufferId UTF8String], (int)frameIndex, info)) {
    reject(@"ERR_IMAGE_BUFFER_NOT_FOUND", @"Frame not found", nil);
    return;
  }
  NSMutableDictionary *dict = [@{
    @"index" : @(info.index),
    @"width" : @(info.width),
    @"height" : @(info.height),
    @"byteSize" : @(info.byteSize),
    @"storageKind" :
        [NSString stringWithUTF8String:sherpa_onnx::image::StorageKindName(info.storageKind)],
  } mutableCopy];
  if (info.pageNumber > 0) {
    dict[@"pageNumber"] = @(info.pageNumber);
  }
  if (info.dpi > 0) {
    dict[@"dpi"] = @(info.dpi);
  }
  resolve(dict);
}

- (void)releaseOfflineImageBuffer:(NSString *)bufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  ImageRegistry::Instance().Release([bufferId UTF8String]);
  resolve(nil);
}

- (void)cancelOfflineImageBufferCreate:(NSString *)operationId
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject {
  SetCancel(operationId, true);
  resolve(nil);
}

- (void)exportOfflineImageBufferFrame:(NSString *)bufferId
                           frameIndex:(double)frameIndex
                          destination:(NSDictionary *)destination
                              options:(NSDictionary *)options
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();

  NSString *formatStr = [(options[@"format"] ?: @"jpeg") lowercaseString];
  int quality = options[@"quality"] != nil ? [options[@"quality"] intValue] : 85;
  int maxSide = options[@"maxSide"] != nil ? [options[@"maxSide"] intValue] : 0;

  sherpa_onnx::image::ExportFormat format = sherpa_onnx::image::ExportFormat::Jpeg;
  if (!sherpa_onnx::image::ParseExportFormat([formatStr UTF8String], &format)) {
    reject(@"ERR_IMAGE_INVALID_ARGUMENT", @"unsupported export format", nil);
    return;
  }

  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOWriteHandle *wh =
      [FileIOResolver resolveDestination:destination
                               overwrite:YES
                  createParentDirectories:YES
                                    error:&errCode
                                  message:&errMsg];
  if (!wh || wh.filePath.length == 0) {
    reject(errCode ?: @"ERR_IMAGE_INVALID_ARGUMENT",
           errMsg ?: @"Failed to resolve FileDestination", nil);
    return;
  }

  sherpa_onnx::image::ExportOptions opts;
  opts.format = format;
  opts.quality = quality;
  opts.maxSide = maxSide;

  const auto result = sherpa_onnx::image::ExportFrameToFile(
      [bufferId UTF8String], (int)frameIndex, [wh.filePath UTF8String], opts);
  if (!result.ok) {
    [wh cleanup];
    [[NSFileManager defaultManager] removeItemAtPath:wh.filePath error:nil];
    reject([NSString stringWithUTF8String:result.errorCode.c_str()],
           [NSString stringWithUTF8String:result.errorMessage.c_str()], nil);
    return;
  }

  NSString *resultPath = wh.resultPath.length > 0 ? wh.resultPath : wh.filePath;
  [wh cleanup];
  resolve(@{ @"outputKind" : @"fs", @"outputPath" : resultPath ?: wh.filePath });
}

@end
