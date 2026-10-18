#import "../../SherpaOnnx.h"
#import "../../fileio/FileIOResolver.h"
#import "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include "ImageRegistry.h"
#include "pdf/PdfFeatureGuard.h"
#include "pdf/PdfPageRasterizer.h"
#include "pdf/PdfTextLayerExtractor.h"

#include <mutex>
#include <string>
#include <vector>

using sherpa_onnx::image::ImageRegistry;
using sherpa_onnx::image::ImageThresholdPathType;
using sherpa_onnx::image::ImageThresholdPlatform;

namespace {

void EnsureImageRegistryInitForPdf() {
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

}  // namespace

@implementation SherpaOnnx (PDF)

RCT_EXPORT_METHOD(isPdfiumEnabled : (RCTPromiseResolveBlock)
                      resolve rejecter : (RCTPromiseRejectBlock)reject) {
  resolve(@(sherpa_onnx::pdf::IsPdfiumCompiledIn() ? YES : NO));
}

RCT_EXPORT_METHOD(extractPdfTextLayer : (NSDictionary *)source textOutBufferId : (
                      NSString *)textOutBufferId options : (NSDictionary *)
                      options resolver : (RCTPromiseResolveBlock)
                          resolve rejecter : (RCTPromiseRejectBlock)reject) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    reject(@"ERR_PDF_PDFIUM_DISABLED",
           @"PDFium is not linked. Rebuild with SHERPA_ONNX_ENABLE_PDFIUM=1 "
           @"and ensure pdfium prebuilts resolve.",
           nil);
    return;
  }

  if (textOutBufferId.length == 0) {
    reject(@"ERR_PDF_INVALID_ARGUMENT", @"textOutBufferId required", nil);
    return;
  }

  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *handle =
      [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!handle) {
    reject(errCode ?: @"ERR_PDF_OPEN_FAILED",
           errMsg ?: @"Failed to resolve PDF FileSource", nil);
    return;
  }

  NSData *data = nil;
  if (handle.isFilePath && handle.filePath.length > 0) {
    data = [NSData dataWithContentsOfFile:handle.filePath];
  } else if (handle.stream != nil) {
    [handle.stream open];
    NSMutableData *buf = [NSMutableData data];
    uint8_t chunk[65536];
    NSInteger n = 0;
    while ((n = [handle.stream read:chunk maxLength:sizeof(chunk)]) > 0) {
      [buf appendBytes:chunk length:(NSUInteger)n];
    }
    data = buf;
  }
  [handle cleanup];

  if (!data || data.length == 0) {
    reject(@"ERR_PDF_INVALID_ARGUMENT", @"PDF FileSource is empty", nil);
    return;
  }

  sherpa_onnx::pdf::ExtractOptions opts;
  id pagesVal = options[@"pages"];
  if ([pagesVal isKindOfClass:[NSArray class]]) {
    for (id p in (NSArray *)pagesVal) {
      if ([p respondsToSelector:@selector(intValue)]) {
        opts.pages.push_back([p intValue]);
      }
    }
  }

  if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
    [self sendEventWithName:@"SherpaOnnxPdfProgress"
                       body:@{@"done" : @0, @"total" : @1, @"phase" : @"extract"}];
  }

  const auto result = sherpa_onnx::pdf::ExtractPdfTextLayer(
      static_cast<const uint8_t *>(data.bytes), data.length, opts);
  if (!result.ok) {
    NSString *code = result.error_code.empty()
                         ? @"ERR_PDF_INTERNAL"
                         : [NSString stringWithUTF8String:result.error_code.c_str()];
    NSString *msg =
        result.error_message.empty()
            ? @"PDF text-layer extract failed"
            : [NSString stringWithUTF8String:result.error_message.c_str()];
    reject(code, msg, nil);
    return;
  }

  std::vector<TxtSpatialSpan> spans;
  spans.reserve(result.spans.size());
  for (const auto &s : result.spans) {
    TxtSpatialSpan t;
    t.utf16Start = s.utf16_start;
    t.utf16End = s.utf16_end;
    t.level = s.level;
    t.sourceImageBufferId = "";
    t.frameIndex = s.frame_index;
    for (int i = 0; i < 8; ++i) {
      t.quad[i] = s.quad[i];
    }
    t.origin = "textLayer";
    t.hasPageNumber = true;
    t.pageNumber = s.page_number;
    t.hasPageWidth = true;
    t.pageWidth = s.page_width;
    t.hasPageHeight = true;
    t.pageHeight = s.page_height;
    spans.push_back(t);
  }

  std::string popErr;
  const bool ok = txt_populate_offline_if_empty(
      [textOutBufferId UTF8String], result.text, {}, {}, {}, "", "", "", spans,
      &popErr);
  if (!ok) {
    reject(@"ERR_PDF_INVALID_ARGUMENT",
           popErr.empty()
               ? @"Failed to populate text buffer"
               : [NSString stringWithUTF8String:popErr.c_str()],
           nil);
    return;
  }

  if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
    [self sendEventWithName:@"SherpaOnnxPdfProgress"
                       body:@{@"done" : @1, @"total" : @1, @"phase" : @"done"}];
  }

  NSString *nsText = [NSString stringWithUTF8String:result.text.c_str()] ?: @"";
  resolve(@{
    @"pageCount" : @(result.page_count),
    @"pagesWithText" : @(result.pages_with_text),
    @"utf16Length" : @(nsText.length),
    @"spatialSpanCount" : @((NSInteger)result.spans.size()),
  });
}

RCT_EXPORT_METHOD(rasterizePdfPages : (NSDictionary *)source options : (
                      NSDictionary *)options resolver : (RCTPromiseResolveBlock)
                          resolve rejecter : (RCTPromiseRejectBlock)reject) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    reject(@"ERR_PDF_PDFIUM_DISABLED",
           @"PDFium is not linked. Rebuild with SHERPA_ONNX_ENABLE_PDFIUM=1 "
           @"and ensure pdfium prebuilts resolve.",
           nil);
    return;
  }

  EnsureImageRegistryInitForPdf();

  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *handle =
      [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!handle) {
    reject(errCode ?: @"ERR_PDF_OPEN_FAILED",
           errMsg ?: @"Failed to resolve PDF FileSource", nil);
    return;
  }

  NSData *data = nil;
  if (handle.isFilePath && handle.filePath.length > 0) {
    data = [NSData dataWithContentsOfFile:handle.filePath];
  } else if (handle.stream != nil) {
    [handle.stream open];
    NSMutableData *buf = [NSMutableData data];
    uint8_t chunk[65536];
    NSInteger n = 0;
    while ((n = [handle.stream read:chunk maxLength:sizeof(chunk)]) > 0) {
      [buf appendBytes:chunk length:(NSUInteger)n];
    }
    data = buf;
  }
  [handle cleanup];

  if (!data || data.length == 0) {
    reject(@"ERR_PDF_INVALID_ARGUMENT", @"PDF FileSource is empty", nil);
    return;
  }

  sherpa_onnx::pdf::RasterOptions opts;
  id pagesVal = options[@"pages"];
  if ([pagesVal isKindOfClass:[NSArray class]]) {
    for (id p in (NSArray *)pagesVal) {
      if ([p respondsToSelector:@selector(intValue)]) {
        opts.pages.push_back([p intValue]);
      }
    }
  }
  id dpiVal = options[@"dpi"];
  if ([dpiVal respondsToSelector:@selector(intValue)]) {
    int dpi = [dpiVal intValue];
    if (dpi > 0) {
      opts.dpi = dpi;
    }
  }
  id maxSideVal = options[@"maxSide"];
  if ([maxSideVal respondsToSelector:@selector(intValue)]) {
    opts.max_side = [maxSideVal intValue];
  }

  if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
    [self sendEventWithName:@"SherpaOnnxPdfProgress"
                       body:@{@"done" : @0, @"total" : @1, @"phase" : @"raster"}];
  }

  auto raster = sherpa_onnx::pdf::RasterizePdfPages(
      static_cast<const uint8_t *>(data.bytes), data.length, opts);
  if (!raster.ok) {
    NSString *code = raster.error_code.empty()
                         ? @"ERR_PDF_INTERNAL"
                         : [NSString stringWithUTF8String:raster.error_code.c_str()];
    NSString *msg =
        raster.error_message.empty()
            ? @"PDF rasterize failed"
            : [NSString stringWithUTF8String:raster.error_message.c_str()];
    reject(code, msg, nil);
    return;
  }

  auto created = ImageRegistry::Instance().CreateFromRgbFrames(
      std::move(raster.frames), ImageThresholdPathType::FileOrigin);
  if (!created.ok) {
    NSString *code = created.errorCode.empty()
                         ? @"ERR_PDF_INTERNAL"
                         : [NSString stringWithUTF8String:created.errorCode.c_str()];
    NSString *msg = created.errorMessage.empty()
                        ? @"Failed to create ImageBuffer from PDF pages"
                        : [NSString stringWithUTF8String:created.errorMessage.c_str()];
    reject(code, msg, nil);
    return;
  }

  if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
    [self sendEventWithName:@"SherpaOnnxPdfProgress"
                       body:@{@"done" : @1, @"total" : @1, @"phase" : @"done"}];
  }

  resolve(@{
    @"bufferId" : [NSString stringWithUTF8String:created.info.bufferId.c_str()],
    @"kind" : @"offlineImageBuffer",
    @"state" : @"immutable",
    @"frameCount" : @(created.info.frameCount),
    @"totalBytes" : @(created.info.totalBytes),
    @"storageKind" : [NSString
        stringWithUTF8String:sherpa_onnx::image::StorageKindName(
                                 created.info.storageKind)],
    @"pageCount" : @(raster.page_count),
  });
}

@end
