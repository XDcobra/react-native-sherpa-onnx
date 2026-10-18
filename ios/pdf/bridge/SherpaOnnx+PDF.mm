#import "../../SherpaOnnx.h"
#import "../../fileio/FileIOResolver.h"
#import "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include "pdf/PdfFeatureGuard.h"
#include "pdf/PdfTextLayerExtractor.h"

#include <string>
#include <vector>

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

@end
