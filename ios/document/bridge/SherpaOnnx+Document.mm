#import "../../SherpaOnnx.h"
#import "../../fileio/FileIOResolver.h"
#import "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

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

sherpa_onnx::document::DocumentSource MakeSrc(FileIOReadHandle *handle,
                                              NSString **errCode,
                                              NSString **errMsg) {
  sherpa_onnx::document::DocumentSource src;
  if (!handle || !handle.isFilePath || handle.filePath.length == 0) {
    if (errCode) *errCode = @"ERR_DOC_OPEN_FAILED";
    if (errMsg) {
      *errMsg = @"ERR_DOC_OPEN_FAILED: source is not seekable (document "
                @"requires a filesystem path)";
    }
    return src;
  }
  src.path = [handle.filePath UTF8String];
  src.fd = -1;
  return src;
}

}  // namespace

@implementation SherpaOnnx (Document)

RCT_EXPORT_METHOD(extractDocumentText : (NSDictionary *)source textOutBufferId : (
                      NSString *)textOutBufferId options : (NSDictionary *)
                      options resolver : (RCTPromiseResolveBlock)
                          resolve rejecter : (RCTPromiseRejectBlock)reject) {
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
    const auto src = MakeSrc(handle, &seekErr, &seekMsg);
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

    std::vector<TxtSpatialSpan> spans;
    spans.reserve(result.spans.size());
    for (const auto &s : result.spans) {
      TxtSpatialSpan t;
      t.utf16Start = s.utf16_start;
      t.utf16End = s.utf16_end;
      t.level = s.level.empty() ? "block" : s.level;
      t.sourceImageBufferId = "";
      t.frameIndex = 0;
      t.origin = "markup";
      t.hasSectionIndex = true;
      t.sectionIndex = s.section_index;
      t.href = s.href;
      spans.push_back(t);
    }

    std::string popErr;
    const bool ok = txt_populate_offline_if_empty(
        [textOutBufferId UTF8String], result.text, {}, {}, {}, "", "", "",
        spans, &popErr);
    if (!ok) {
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

    resolve(@{
      @"format" : [NSString stringWithUTF8String:result.format.c_str()] ?: @"",
      @"sectionCount" : @((NSInteger)result.sections.size()),
      @"sections" : sections,
      @"imageOnlySections" : imageOnly,
      @"spatialSpanCount" : @((NSInteger)result.spans.size()),
    });
  });
}

RCT_EXPORT_METHOD(extractDocumentImages : (NSDictionary *)source options : (
                      NSDictionary *)options resolver : (RCTPromiseResolveBlock)
                          resolve rejecter : (RCTPromiseRejectBlock)reject) {
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
    const auto src = MakeSrc(handle, &seekErr, &seekMsg);
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
    [handle cleanup];
    if (!result.ok) {
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

    std::vector<sherpa_onnx::image::RgbFrame> frames;
    frames.reserve(result.frames.size());
    for (auto &fr : result.frames) {
      fr.rgb.sectionIndex = fr.section_index;
      fr.rgb.href = fr.href;
      fr.rgb.pageNumber = fr.page_number;
      frames.push_back(std::move(fr.rgb));
    }
    auto created = ImageRegistry::Instance().CreateFromRgbFrames(
        std::move(frames), ImageThresholdPathType::FileOrigin);
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
