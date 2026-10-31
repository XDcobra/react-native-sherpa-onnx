#import "SherpaOnnx.h"
#import "../fileio/FileIOResolver.h"
#import "../pdf/bridge/PdfLazyIo.h"

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
using sherpa_onnx::image::ImageRetention;
using sherpa_onnx::image::ImageThresholdPathType;
using sherpa_onnx::image::ImageThresholdPlatform;
using sherpa_onnx::image::LiveImageOptions;
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

bool DecodeHeicToRgb(NSData *data, int maxSide, RgbFrame &out, NSString **errOut);

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
    ImageDecoder::SetPlatformHeicDecoder(
        [](const uint8_t *data, size_t size, const DecodeOptions &opts) {
          sherpa_onnx::image::DecodeResult r;
          r.format = sherpa_onnx::image::DecodeFormat::Heic;
          if (!data || size == 0) {
            r.ok = false;
            r.errorCode = "ERR_IMAGE_DECODE_FAILED";
            r.errorMessage = "empty image bytes";
            return r;
          }
          NSData *ns = [NSData dataWithBytes:data length:size];
          RgbFrame frame;
          NSString *err = nil;
          if (!DecodeHeicToRgb(ns, opts.maxSide, frame, &err)) {
            r.ok = false;
            r.errorCode = "ERR_IMAGE_FORMAT_UNSUPPORTED";
            r.errorMessage = err ? [err UTF8String] : "HEIC decode failed";
            return r;
          }
          r.ok = true;
          r.frame = std::move(frame);
          return r;
        });
  });
}

NSDictionary *InfoDict(const sherpa_onnx::image::ImageBufferInfo &info) {
  NSMutableDictionary *dict = [@{
    @"bufferId" : [NSString stringWithUTF8String:info.bufferId.c_str()],
    @"kind" : [NSString
        stringWithUTF8String:sherpa_onnx::image::BufferKindName(info.kind)],
    @"state" : [NSString
        stringWithUTF8String:sherpa_onnx::image::BufferStateName(info.state)],
    @"frameCount" : @(info.frameCount),
    @"totalBytes" : @(info.totalBytes),
    @"storageKind" :
        [NSString stringWithUTF8String:sherpa_onnx::image::StorageKindName(info.storageKind)],
  } mutableCopy];
  if (info.kind == sherpa_onnx::image::ImageBufferKind::Live) {
    dict[@"totalFramesWritten"] = @(info.totalFramesWritten);
    dict[@"ringEvictedFrames"] = @(info.ringEvictedFrames);
    dict[@"hasActiveSpool"] = @(info.hasActiveSpool);
  }
  return dict;
}

NSDictionary *FrameInfoDict(const sherpa_onnx::image::ImageFrameInfo &info) {
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
  if (info.sectionIndex >= 0) {
    dict[@"sectionIndex"] = @(info.sectionIndex);
  }
  if (!info.href.empty()) {
    dict[@"href"] = [NSString stringWithUTF8String:info.href.c_str()] ?: @"";
  }
  if (!info.sourceVideoBufferId.empty()) {
    dict[@"sourceVideoBufferId"] =
        [NSString stringWithUTF8String:info.sourceVideoBufferId.c_str()] ?: @"";
    dict[@"sourcePtsUs"] = @(info.sourcePtsUs);
    dict[@"sourceFrameIndex"] = @(info.sourceFrameIndex);
  }
  return dict;
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

int HotFramesFromOptions(NSDictionary *options) {
  if (options[@"hotFrames"] != nil) return [options[@"hotFrames"] intValue];
  return 0;
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
  int hotFrames = HotFramesFromOptions(options);
  NSString *operationId = options[@"operationId"];
  if (operationId.length > 0) SetCancel(operationId, false);

  NSInteger total = sources.count;
  std::vector<std::string> paths;
  std::vector<std::vector<uint8_t>> blobs;
  BOOL allFiles = YES;
  for (NSInteger i = 0; i < total; ++i) {
    if (IsCancelled(operationId)) {
      SetCancel(operationId, false);
      reject(@"ERR_IMAGE_CANCELLED", @"cancelled", nil);
      return;
    }
    EmitProgress(self, operationId, (int)i, (int)total, @"index");

    id item = sources[i];
    if (![item isKindOfClass:[NSDictionary class]]) {
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
      reject(errCode ?: @"ERR_IMAGE_DECODE_FAILED", errMsg ?: @"Failed to resolve FileSource", nil);
      return;
    }

    if (readHandle.isFilePath && readHandle.filePath.length > 0) {
      paths.push_back([readHandle.filePath UTF8String]);
    } else {
      allFiles = NO;
      NSData *data = nil;
      if (readHandle.stream != nil) {
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
        reject(@"ERR_IMAGE_DECODE_FAILED", @"empty or unreadable FileSource", nil);
        return;
      }
      const auto *bytes = (const uint8_t *)data.bytes;
      blobs.emplace_back(bytes, bytes + data.length);
      continue;
    }
    [readHandle cleanup];
  }

  DecodeOptions opts;
  opts.maxSide = maxSide;
  opts.hotFrames = hotFrames;
  ImageRegistry::CreateResult created;
  if (allFiles && paths.size() == static_cast<size_t>(total)) {
    created = ImageRegistry::Instance().CreateFromFiles(paths, opts);
  } else {
    blobs.clear();
    for (NSInteger i = 0; i < total; ++i) {
      NSDictionary *source = sources[i];
      NSString *errCode = nil;
      NSString *errMsg = nil;
      FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source
                                                             error:&errCode
                                                           message:&errMsg];
      if (!readHandle) {
        reject(errCode ?: @"ERR_IMAGE_DECODE_FAILED", errMsg ?: @"Failed to resolve FileSource",
               nil);
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
        reject(@"ERR_IMAGE_DECODE_FAILED", @"empty or unreadable FileSource", nil);
        return;
      }
      const auto *bytes = (const uint8_t *)data.bytes;
      blobs.emplace_back(bytes, bytes + data.length);
    }
    created = ImageRegistry::Instance().CreateFromBytesList(
        blobs, opts, ImageThresholdPathType::FileOrigin);
  }
  if (!created.ok) {
    reject(@(created.errorCode.c_str()), @(created.errorMessage.c_str()), nil);
    SetCancel(operationId, false);
    return;
  }
  EmitProgress(self, operationId, (int)total, (int)total, @"done");
  SetCancel(operationId, false);
  resolve(InfoDict(created.info));
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
  int hotFrames = HotFramesFromOptions(options);
  NSString *operationId = options[@"operationId"];
  if (operationId.length > 0) SetCancel(operationId, false);

  NSInteger total = base64List.count;
  std::vector<std::vector<uint8_t>> blobs;
  blobs.reserve(static_cast<size_t>(total));
  for (NSInteger i = 0; i < total; ++i) {
    if (IsCancelled(operationId)) {
      SetCancel(operationId, false);
      reject(@"ERR_IMAGE_CANCELLED", @"cancelled", nil);
      return;
    }
    EmitProgress(self, operationId, (int)i, (int)total, @"index");
    NSString *b64 = [base64List[i] description];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
    if (!data) {
      reject(@"ERR_IMAGE_DECODE_FAILED", @"invalid base64", nil);
      return;
    }
    const auto *bytes = (const uint8_t *)data.bytes;
    blobs.emplace_back(bytes, bytes + data.length);
  }
  DecodeOptions opts;
  opts.maxSide = maxSide;
  opts.hotFrames = hotFrames;
  auto created = ImageRegistry::Instance().CreateFromBytesList(
      blobs, opts, ImageThresholdPathType::HeapOrigin);
  if (!created.ok) {
    reject(@(created.errorCode.c_str()), @(created.errorMessage.c_str()), nil);
    SetCancel(operationId, false);
    return;
  }
  EmitProgress(self, operationId, (int)total, (int)total, @"done");
  SetCancel(operationId, false);
  resolve(InfoDict(created.info));
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
  resolve(FrameInfoDict(info));
}

- (void)ensureOfflineImageBufferFrame:(NSString *)bufferId
                           frameIndex:(double)frameIndex
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    auto ensured = ImageRegistry::Instance().EnsureFrame(
        [bufferId UTF8String], (int)frameIndex);
    if (!ensured.ok) {
      NSString *code = ensured.errorCode.empty()
                           ? @"ERR_IMAGE_INTERNAL"
                           : [NSString stringWithUTF8String:ensured.errorCode.c_str()];
      NSString *msg = ensured.errorMessage.empty()
                          ? @"ensure frame failed"
                          : [NSString stringWithUTF8String:ensured.errorMessage.c_str()];
      reject(code, msg, nil);
      return;
    }
    resolve(FrameInfoDict(ensured.info));
  });
}

- (void)releaseOfflineImageBuffer:(NSString *)bufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  ImageRegistry::Instance().Release([bufferId UTF8String]);
  SherpaOnnxPdfReleaseLazyHandle(bufferId);
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

- (void)emitLiveImageAppendEvents:(NSString *)bufferId
                           before:(NSDictionary *)before
                            after:(NSDictionary *)after {
  long long evictedBefore = [before[@"ringEvictedFrames"] longLongValue];
  long long evictedAfter = [after[@"ringEvictedFrames"] longLongValue];
  if (evictedAfter > evictedBefore) {
    [self emitLiveImageEvent:@"overflow" bufferId:bufferId info:after];
  }
  [self emitLiveImageEvent:@"framesAppended" bufferId:bufferId info:after];
}

- (void)emitLiveImageEvent:(NSString *)type bufferId:(NSString *)bufferId info:(NSDictionary *)info {
  NSMutableDictionary *body = [@{
    @"type" : type ?: @"framesAppended",
    @"liveBufferId" : bufferId ?: @"",
  } mutableCopy];
  if (info[@"frameCount"] != nil) body[@"frameCount"] = info[@"frameCount"];
  if (info[@"totalFramesWritten"] != nil)
    body[@"totalFramesWritten"] = info[@"totalFramesWritten"];
  [self sendEventWithName:@"SherpaOnnxImageLiveEvent" body:body];
}

- (void)createEmptyLiveImageBuffer:(NSDictionary *)options
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  LiveImageOptions opts;
  if (options[@"ringFrames"] != nil) opts.ringFrames = [options[@"ringFrames"] intValue];
  NSString *retention = [options[@"retention"] description];
  if ([retention isEqualToString:@"none"]) {
    opts.retention = ImageRetention::None;
  }
  auto created = ImageRegistry::Instance().CreateLive(opts);
  resolve(InfoDict(created.info));
}

- (void)appendLiveImageFrame:(NSString *)bufferId
                 base64Bytes:(NSString *)base64Bytes
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  NSData *data = [[NSData alloc] initWithBase64EncodedString:base64Bytes options:0];
  if (!data) {
    reject(@"ERR_IMAGE_INVALID_ARGUMENT", @"invalid base64", nil);
    return;
  }
  const auto *bytes = (const uint8_t *)data.bytes;
  std::vector<uint8_t> blob(bytes, bytes + data.length);
  sherpa_onnx::image::ImageBufferInfo beforeInfo;
  ImageRegistry::Instance().GetInfo([bufferId UTF8String], beforeInfo);
  NSDictionary *beforeDict = InfoDict(beforeInfo);
  auto st = ImageRegistry::Instance().AppendLiveCompressed([bufferId UTF8String], std::move(blob));
  if (!st.ok) {
    reject(@(st.errorCode.c_str()), @(st.errorMessage.c_str()), nil);
    return;
  }
  sherpa_onnx::image::ImageBufferInfo info;
  ImageRegistry::Instance().GetInfo([bufferId UTF8String], info);
  NSDictionary *dict = InfoDict(info);
  [self emitLiveImageAppendEvents:bufferId before:beforeDict after:dict];
  resolve(dict);
}

- (void)ingestFileToLiveImageBuffer:(NSDictionary *)source
                           bufferId:(NSString *)bufferId
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (!readHandle) {
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
    reject(@"ERR_IMAGE_DECODE_FAILED", @"empty or unreadable FileSource", nil);
    return;
  }
  const auto *bytes = (const uint8_t *)data.bytes;
  std::vector<uint8_t> blob(bytes, bytes + data.length);
  sherpa_onnx::image::ImageBufferInfo beforeInfo;
  ImageRegistry::Instance().GetInfo([bufferId UTF8String], beforeInfo);
  NSDictionary *beforeDict = InfoDict(beforeInfo);
  auto st = ImageRegistry::Instance().AppendLiveCompressed([bufferId UTF8String], std::move(blob));
  if (!st.ok) {
    reject(@(st.errorCode.c_str()), @(st.errorMessage.c_str()), nil);
    return;
  }
  sherpa_onnx::image::ImageBufferInfo info;
  ImageRegistry::Instance().GetInfo([bufferId UTF8String], info);
  NSDictionary *dict = InfoDict(info);
  [self emitLiveImageAppendEvents:bufferId before:beforeDict after:dict];
  resolve(dict);
}

- (void)finalizeLiveImageBuffer:(NSString *)bufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject {
  EnsureImageRegistryInit();
  auto st = ImageRegistry::Instance().FinishLive([bufferId UTF8String]);
  if (!st.ok) {
    reject(@(st.errorCode.c_str()), @(st.errorMessage.c_str()), nil);
    return;
  }
  sherpa_onnx::image::ImageBufferInfo info;
  ImageRegistry::Instance().GetInfo([bufferId UTF8String], info);
  NSDictionary *dict = InfoDict(info);
  [self emitLiveImageEvent:@"finished" bufferId:bufferId info:dict];
  resolve(dict);
}

@end
