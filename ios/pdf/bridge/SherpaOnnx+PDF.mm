#import "../../SherpaOnnx.h"
#import "../../fileio/FileIOResolver.h"
#import "../../fileio/FileIOSeekable.h"
#import "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#import "PdfLazyIo.h"

#include "ImageRegistry.h"
#include "pdf/PdfFeatureGuard.h"
#include "pdf/PdfLazySession.h"
#include "pdf/PdfPageRasterizer.h"
#include "pdf/PdfTextLayerExtractor.h"
#include "pdf/PdfTypes.h"

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

static NSMutableDictionary<NSString *, FileIOReadHandle *> *gPdfLazyHandles;
static NSLock *gPdfLazyLock;

static void EnsurePdfLazyHandleStore() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gPdfLazyHandles = [NSMutableDictionary dictionary];
    gPdfLazyLock = [[NSLock alloc] init];
  });
}

void SherpaOnnxPdfRetainLazyHandle(NSString *bufferId,
                                   FileIOReadHandle *handle) {
  if (bufferId.length == 0 || !handle) {
    return;
  }
  EnsurePdfLazyHandleStore();
  [gPdfLazyLock lock];
  FileIOReadHandle *prev = gPdfLazyHandles[bufferId];
  gPdfLazyHandles[bufferId] = handle;
  [gPdfLazyLock unlock];
  if (prev && prev != handle) {
    [prev cleanup];
  }
  NSLog(@"[SherpaOnnx:pdf] retain lazy handle bufferId=%@", bufferId);
}

void SherpaOnnxPdfReleaseLazyHandle(NSString *bufferId) {
  if (bufferId.length == 0) {
    return;
  }
  EnsurePdfLazyHandleStore();
  [gPdfLazyLock lock];
  FileIOReadHandle *handle = gPdfLazyHandles[bufferId];
  [gPdfLazyHandles removeObjectForKey:bufferId];
  [gPdfLazyLock unlock];
  if (handle) {
    NSLog(@"[SherpaOnnx:pdf] release lazy handle bufferId=%@", bufferId);
    [handle cleanup];
  }
}

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

  const auto src = SherpaOnnxSeekableSourceFromHandle(
      handle, @"ERR_PDF_OPEN_FAILED", @"SherpaOnnx:pdf", &errCode, &errMsg);
  if (src.path.empty()) {
    [handle cleanup];
    reject(errCode ?: @"ERR_PDF_OPEN_FAILED",
           errMsg ?: @"Failed to resolve PDF FileSource", nil);
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
  id extractPasswordVal = options[@"password"];
  if ([extractPasswordVal isKindOfClass:[NSString class]]) {
    opts.password = [(NSString *)extractPasswordVal UTF8String];
  }

  if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
    [self sendEventWithName:@"SherpaOnnxPdfProgress"
                       body:@{@"done" : @0, @"total" : @1, @"phase" : @"extract"}];
  }

  const auto result = sherpa_onnx::pdf::ExtractPdfTextLayer(src, opts);
  [handle cleanup];
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

  const auto src = SherpaOnnxSeekableSourceFromHandle(
      handle, @"ERR_PDF_OPEN_FAILED", @"SherpaOnnx:pdf", &errCode, &errMsg);
  if (src.path.empty()) {
    [handle cleanup];
    reject(errCode ?: @"ERR_PDF_OPEN_FAILED",
           errMsg ?: @"Failed to resolve PDF FileSource", nil);
    return;
  }

  std::vector<int> pages;
  id pagesVal = options[@"pages"];
  if ([pagesVal isKindOfClass:[NSArray class]]) {
    for (id p in (NSArray *)pagesVal) {
      if ([p respondsToSelector:@selector(intValue)]) {
        pages.push_back([p intValue]);
      }
    }
  }

  int dpi = 144;
  id dpiVal = options[@"dpi"];
  if ([dpiVal respondsToSelector:@selector(intValue)]) {
    int d = [dpiVal intValue];
    if (d > 0) {
      dpi = d;
    }
  }
  int maxSide = 4096;
  id maxSideVal = options[@"maxSide"];
  if ([maxSideVal respondsToSelector:@selector(intValue)]) {
    maxSide = [maxSideVal intValue];
  }

  NSString *strategy = @"rasterize-all";
  id strategyVal = options[@"strategy"];
  if ([strategyVal isKindOfClass:[NSString class]] &&
      [(NSString *)strategyVal length] > 0) {
    strategy = (NSString *)strategyVal;
  }
  int hotFrames = 0;
  id hotFramesVal = options[@"hotFrames"];
  if ([hotFramesVal respondsToSelector:@selector(intValue)]) {
    hotFrames = [hotFramesVal intValue];
  }
  std::string password;
  id passwordVal = options[@"password"];
  if ([passwordVal isKindOfClass:[NSString class]]) {
    password = [(NSString *)passwordVal UTF8String];
  }

  const BOOL lazy = [strategy isEqualToString:@"lazy-lru"];

  if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
    [self sendEventWithName:@"SherpaOnnxPdfProgress"
                       body:@{@"done" : @0, @"total" : @1, @"phase" : @"raster"}];
  }

  if (lazy) {
    std::string err_code;
    std::string err_msg;
    auto session = sherpa_onnx::pdf::PdfLazySession::Open(
        src, dpi, maxSide, &err_code, &err_msg,
        sherpa_onnx::pdf::PdfPasswordOrNull(password));
    if (!session) {
      [handle cleanup];
      NSString *code = err_code.empty()
                           ? @"ERR_PDF_INTERNAL"
                           : [NSString stringWithUTF8String:err_code.c_str()];
      NSString *msg = err_msg.empty()
                          ? @"Failed to open PDF for lazy-lru"
                          : [NSString stringWithUTF8String:err_msg.c_str()];
      reject(code, msg, nil);
      return;
    }
    const int page_count = session->page_count();
    auto created = ImageRegistry::Instance().CreateLazyPdfSlots(
        std::move(session), pages, hotFrames);
    if (!created.ok) {
      [handle cleanup];
      NSString *code = created.errorCode.empty()
                           ? @"ERR_PDF_INTERNAL"
                           : [NSString stringWithUTF8String:created.errorCode.c_str()];
      NSString *msg =
          created.errorMessage.empty()
              ? @"Failed to create lazy ImageBuffer from PDF"
              : [NSString stringWithUTF8String:created.errorMessage.c_str()];
      reject(code, msg, nil);
      return;
    }
    NSString *bufferId =
        [NSString stringWithUTF8String:created.info.bufferId.c_str()];
    SherpaOnnxPdfRetainLazyHandle(bufferId, handle);
    if ([self respondsToSelector:@selector(sendEventWithName:body:)]) {
      [self sendEventWithName:@"SherpaOnnxPdfProgress"
                         body:@{@"done" : @1, @"total" : @1, @"phase" : @"done"}];
    }
    resolve(@{
      @"bufferId" : bufferId,
      @"kind" : @"offlineImageBuffer",
      @"state" : [NSString
          stringWithUTF8String:sherpa_onnx::image::BufferStateName(created.info.state)],
      @"frameCount" : @(created.info.frameCount),
      @"totalBytes" : @(created.info.totalBytes),
      @"storageKind" : [NSString
          stringWithUTF8String:sherpa_onnx::image::StorageKindName(
                                   created.info.storageKind)],
      @"pageCount" : @(page_count),
    });
    return;
  }

  sherpa_onnx::pdf::RasterOptions opts;
  opts.pages = std::move(pages);
  opts.dpi = dpi;
  opts.max_side = maxSide;
  opts.password = password;

  auto raster = sherpa_onnx::pdf::RasterizePdfPages(src, opts);
  [handle cleanup];
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
    @"state" : [NSString
        stringWithUTF8String:sherpa_onnx::image::BufferStateName(created.info.state)],
    @"frameCount" : @(created.info.frameCount),
    @"totalBytes" : @(created.info.totalBytes),
    @"storageKind" : [NSString
        stringWithUTF8String:sherpa_onnx::image::StorageKindName(
                                 created.info.storageKind)],
    @"pageCount" : @(raster.page_count),
  });
}

@end
