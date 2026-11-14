#import "../../SherpaOnnx.h"
#import "../../fileio/FileIOResolver.h"
#import "../../fileio/FileIOSeekable.h"
#include "TextRegistry.h"

#import "SherpaDocStructureSummary.h"
#import "../../pdf/bridge/PdfLazyIo.h"
#include "DocImagePopulate.h"
#include "DocTextPopulate.h"
#include "DocumentExtractor.h"
#include "ImageRegistry.h"

#include <mutex>
#include <string>
#include <vector>

using sherpa_onnx::image::ImageRegistry;
using sherpa_onnx::image::ImageThresholdPathType;
using sherpa_onnx::image::ImageThresholdPlatform;

namespace {

void EnsureImageRegistryInitForDoc() {
  static std::once_flag once;
  std::call_once(once, []() {
    NSString *cache =
        [NSTemporaryDirectory() stringByAppendingPathComponent:@"sherpa-image"];
    [[NSFileManager defaultManager] createDirectoryAtPath:cache
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    auto &reg = ImageRegistry::Instance();
    reg.SetCacheDir([cache UTF8String]);
    uint64_t ram = [[NSProcessInfo processInfo] physicalMemory];
    reg.ConfigureThreshold(ImageThresholdPlatform::Ios, ram);
  });
}

dispatch_queue_t DocQueue() {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create("com.sherpaonnx.document", DISPATCH_QUEUE_SERIAL);
  });
  return q;
}

}  // namespace


static NSString *SherpaDocNS(const std::string &s) {
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
}

@implementation SherpaOnnx (Document)

RCT_EXPORT_METHOD(extractDocumentText : (NSDictionary *)source textOutBufferId : (
                      NSString *)textOutBufferId options : (NSDictionary *)
                      options resolve : (RCTPromiseResolveBlock)
                          resolve reject : (RCTPromiseRejectBlock)reject) {
  if (textOutBufferId.length == 0) {
    reject(@"ERR_DOC_INVALID_ARGUMENT", @"textOutBufferId required", nil);
    return;
  }
  __weak SherpaOnnx *weakSelf = self;
  dispatch_async(DocQueue(), ^{
    SherpaOnnx *strongSelf = weakSelf;
    if (!strongSelf) {
      reject(@"ERR_DOC_OPEN_FAILED", @"module released", nil);
      return;
    }
    NSString *ioErr = nil;
    NSString *ioMsg = nil;
    FileIOReadHandle *handle =
        [FileIOResolver resolveSource:source error:&ioErr message:&ioMsg];
    if (!handle) {
      reject(ioErr ?: @"ERR_DOC_OPEN_FAILED",
             ioMsg ?: @"Failed to resolve FileSource", nil);
      return;
    }
    NSString *seekErr = nil;
    NSString *seekMsg = nil;
    const auto src = SherpaOnnxSeekableSourceFromHandle(
        handle, @"ERR_DOC_OPEN_FAILED", @"SherpaOnnx:doc", &seekErr, &seekMsg);
    if (src.path.empty()) {
      [handle cleanup];
      reject(seekErr ?: @"ERR_DOC_OPEN_FAILED",
             seekMsg ?: @"Source is not seekable", nil);
      return;
    }

    sherpa_onnx::document::ExtractOptions opt;
    opt.on_progress = [strongSelf](int done, int total, const char *phase) {
      if (![strongSelf respondsToSelector:@selector(sendEventWithName:body:)]) {
        return;
      }
      NSString *p = phase ? [NSString stringWithUTF8String:phase] : @"";
      [strongSelf sendEventWithName:@"SherpaOnnxDocProgress"
                               body:@{
                                 @"done" : @(done),
                                 @"total" : @(total),
                                 @"phase" : p ?: @""
                               }];
    };

    const auto result = sherpa_onnx::document::ExtractDocumentText(src, opt);
    [handle cleanup];
    if (!result.ok) {
      NSString *code =
          result.error_code.empty()
              ? @"ERR_DOC_OPEN_FAILED"
              : [NSString stringWithUTF8String:result.error_code.c_str()];
      NSString *msg =
          result.error_message.empty()
              ? @"extractDocumentText failed"
              : [NSString stringWithUTF8String:result.error_message.c_str()];
      reject(code, [NSString stringWithFormat:@"%@: %@", code, msg], nil);
      return;
    }

    std::string popErr;
    if (!sherpa_onnx::document::PopulateTextBufferFromDocument(
            [textOutBufferId UTF8String], result, &popErr)) {
      reject(@"ERR_DOC_INVALID_ARGUMENT",
             popErr.empty()
                 ? @"Failed to populate text buffer"
                 : [NSString stringWithUTF8String:popErr.c_str()],
             nil);
      return;
    }

    NSMutableArray *sections = [NSMutableArray array];
    for (const auto &sec : result.sections) {
      NSMutableDictionary *m = [NSMutableDictionary dictionary];
      m[@"sectionIndex"] = @(sec.section_index);
      m[@"kind"] = [NSString stringWithUTF8String:sec.kind.c_str()] ?: @"text";
      if (!sec.href.empty()) {
        m[@"href"] = [NSString stringWithUTF8String:sec.href.c_str()];
      }
      [sections addObject:m];
    }
    NSMutableArray *imageOnly = [NSMutableArray array];
    for (const auto &sec : result.image_only_sections) {
      NSMutableDictionary *m = [NSMutableDictionary dictionary];
      m[@"sectionIndex"] = @(sec.section_index);
      m[@"kind"] = @"image";
      if (!sec.href.empty()) {
        m[@"href"] = [NSString stringWithUTF8String:sec.href.c_str()];
      }
      [imageOnly addObject:m];
    }

    NSMutableDictionary *out = [@{
      @"format" : [NSString stringWithUTF8String:result.format.c_str()] ?: @"",
      @"sectionCount" : @((NSInteger)result.sections.size()),
      @"sections" : sections,
      @"imageOnlySections" : imageOnly,
      @"spatialSpanCount" : @((NSInteger)result.spans.size()),
    } mutableCopy];
    if (result.structure) {
      out[@"structure"] = SherpaDocStructureSummary(*result.structure);
    }
    resolve(out);
  });
}

RCT_EXPORT_METHOD(detectDocumentFormat : (NSDictionary *)source resolve : (
                      RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(DocQueue(), ^{
    NSString *ioErr = nil;
    NSString *ioMsg = nil;
    FileIOReadHandle *handle = [FileIOResolver resolveSource:source error:&ioErr message:&ioMsg];
    if (!handle) {
      reject(ioErr ?: @"ERR_DOC_OPEN_FAILED", ioMsg ?: @"Failed to resolve FileSource", nil);
      return;
    }
    NSString *seekErr = nil;
    NSString *seekMsg = nil;
    const auto src = SherpaOnnxSeekableSourceFromHandle(handle, @"ERR_DOC_OPEN_FAILED",
                                                        @"SherpaOnnx:doc", &seekErr, &seekMsg);
    if (src.path.empty()) {
      [handle cleanup];
      reject(seekErr ?: @"ERR_DOC_OPEN_FAILED", seekMsg ?: @"Source is not seekable", nil);
      return;
    }
    std::string code;
    std::string msg;
    const std::string format = sherpa_onnx::document::DetectDocumentFormat(src, &code, &msg);
    [handle cleanup];
    if (!code.empty()) {
      NSString *c = SherpaDocNS(code);
      reject(c, [NSString stringWithFormat:@"%@: %@", c, SherpaDocNS(msg)], nil);
      return;
    }
    resolve(SherpaDocNS(format));
  });
}

RCT_EXPORT_METHOD(extractDocumentImages : (NSDictionary *)source options : (
                      NSDictionary *)options resolve : (RCTPromiseResolveBlock)
                          resolve reject : (RCTPromiseRejectBlock)reject) {
  __weak SherpaOnnx *weakSelf = self;
  dispatch_async(DocQueue(), ^{
    SherpaOnnx *strongSelf = weakSelf;
    if (!strongSelf) {
      reject(@"ERR_DOC_OPEN_FAILED", @"module released", nil);
      return;
    }
    EnsureImageRegistryInitForDoc();
    NSString *ioErr = nil;
    NSString *ioMsg = nil;
    FileIOReadHandle *handle =
        [FileIOResolver resolveSource:source error:&ioErr message:&ioMsg];
    if (!handle) {
      reject(ioErr ?: @"ERR_DOC_OPEN_FAILED",
             ioMsg ?: @"Failed to resolve FileSource", nil);
      return;
    }
    NSString *seekErr = nil;
    NSString *seekMsg = nil;
    const auto src = SherpaOnnxSeekableSourceFromHandle(
        handle, @"ERR_DOC_OPEN_FAILED", @"SherpaOnnx:doc", &seekErr, &seekMsg);
    if (src.path.empty()) {
      [handle cleanup];
      reject(seekErr ?: @"ERR_DOC_OPEN_FAILED",
             seekMsg ?: @"Source is not seekable", nil);
      return;
    }

    sherpa_onnx::document::ExtractOptions opt;
    id maxSideVal = options[@"maxSide"];
    if ([maxSideVal respondsToSelector:@selector(intValue)]) {
      opt.max_side = [maxSideVal intValue];
    }
    id scopeVal = options[@"scope"];
    if ([scopeVal isKindOfClass:NSString.class] && [scopeVal isEqualToString:@"all"]) {
      opt.all_images = true;
    }
    id strategyVal = options[@"strategy"];
    opt.lazy = [strategyVal isKindOfClass:NSString.class] &&
               [strategyVal isEqualToString:@"lazy-lru"];
    int hotFrames = 0;
    id hotVal = options[@"hotFrames"];
    if ([hotVal respondsToSelector:@selector(intValue)]) {
      hotFrames = [hotVal intValue];
    }
    opt.on_progress = [strongSelf](int done, int total, const char *phase) {
      if (![strongSelf respondsToSelector:@selector(sendEventWithName:body:)]) {
        return;
      }
      NSString *p = phase ? [NSString stringWithUTF8String:phase] : @"";
      [strongSelf sendEventWithName:@"SherpaOnnxDocProgress"
                               body:@{
                                 @"done" : @(done),
                                 @"total" : @(total),
                                 @"phase" : p ?: @""
                               }];
    };

    auto result = sherpa_onnx::document::ExtractDocumentImages(src, opt);
    const bool lazyResult = !result.frames.empty() && result.frames.front().load;
    // Lazy pages read from the file later: keep the (security-scoped) handle
    // until the buffer is released.
    if (!lazyResult) [handle cleanup];
    if (!result.ok) {
      if (lazyResult) [handle cleanup];
      NSString *code =
          result.error_code.empty()
              ? @"ERR_DOC_OPEN_FAILED"
              : [NSString stringWithUTF8String:result.error_code.c_str()];
      NSString *msg =
          result.error_message.empty()
              ? @"extractDocumentImages failed"
              : [NSString stringWithUTF8String:result.error_message.c_str()];
      reject(code, [NSString stringWithFormat:@"%@: %@", code, msg], nil);
      return;
    }

    auto created = sherpa_onnx::document::CreateImageBufferFromDocument(result, opt.max_side,
                                                                        hotFrames);
    if (lazyResult) {
      if (created.ok) {
        SherpaOnnxPdfRetainLazyHandle(
            [NSString stringWithUTF8String:created.info.bufferId.c_str()], handle);
      } else {
        [handle cleanup];
      }
    }
    if (!created.ok) {
      NSString *code = created.errorCode.empty()
                           ? @"ERR_DOC_OPEN_FAILED"
                           : [NSString stringWithUTF8String:created.errorCode.c_str()];
      NSString *msg =
          created.errorMessage.empty()
              ? @"Failed to create ImageBuffer from document frames"
              : [NSString stringWithUTF8String:created.errorMessage.c_str()];
      reject(code, msg, nil);
      return;
    }
    resolve(@{
      @"bufferId" :
          [NSString stringWithUTF8String:created.info.bufferId.c_str()],
      @"format" : [NSString stringWithUTF8String:result.format.c_str()] ?: @"",
      @"frameCount" : @(created.info.frameCount),
    });
  });
}

@end
