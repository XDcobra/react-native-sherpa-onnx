#import "../../SherpaOnnx.h"

#include "ImageRegistry.h"
#include "OcrDetect.h"
#include "OcrEngine.h"
#include "OcrTypes.h"
#include "../../detect/native/sherpa-onnx-public-language-row-bridge.h"
#include "../../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <map>
#include <mutex>
#include <string>
#include <vector>

using sherpa_onnx::image::ImageRegistry;
using sherpa_onnx::ocr::DetectOcrModel;
using sherpa_onnx::ocr::OcrCancelRegistry;
using sherpa_onnx::ocr::OcrEngine;
using sherpa_onnx::ocr::OcrEngineRegistry;
using sherpa_onnx::ocr::OcrGranularity;
using sherpa_onnx::ocr::OcrLoadOptions;
using sherpa_onnx::ocr::OcrSpanLevel;

namespace {

std::mutex g_ocr_emit_mutex;

static NSString *kOcrInstanceNotFound = @"OCR_INSTANCE_NOT_FOUND";
static NSString *kOcrInvalidArg = @"OCR_INVALID_ARGUMENT";
static NSString *kOcrInternal = @"OCR_INTERNAL_ERROR";
static NSString *kOcrCancelled = @"OCR_CANCELLED";
static NSString *kOcrRecognizeFailed = @"OCR_RECOGNIZE_FAILED";
static NSString *kOcrAlreadyPopulated = @"OCR_ALREADY_POPULATED";

static void EmitOcrProgress(SherpaOnnx *bridge, NSString *operationId, int done,
                            int total, NSString *phase) {
  if (operationId.length == 0 || bridge == nil) return;
  std::lock_guard<std::mutex> lock(g_ocr_emit_mutex);
  [bridge sendEventWithName:@"SherpaOnnxOcrProgress"
                       body:@{
                         @"operationId" : operationId,
                         @"done" : @(done),
                         @"total" : @(total),
                         @"phase" : phase ?: @"recognize",
                       }];
}

static const char *SpanLevelName(OcrSpanLevel level) {
  switch (level) {
    case OcrSpanLevel::kWord:
      return "word";
    case OcrSpanLevel::kBlock:
      return "block";
    case OcrSpanLevel::kLine:
    default:
      return "line";
  }
}

static OcrGranularity ParseGranularity(NSString *raw) {
  if ([raw isEqualToString:@"word"]) return OcrGranularity::kWord;
  if ([raw isEqualToString:@"block"]) return OcrGranularity::kBlock;
  return OcrGranularity::kLine;
}

static std::vector<TxtSpatialSpan> MapSpansToTxt(
    const sherpa_onnx::ocr::OcrResult &result, const std::string &imageBufferId) {
  std::vector<TxtSpatialSpan> out;
  out.reserve(result.spans.size());
  for (const auto &span : result.spans) {
    TxtSpatialSpan t;
    t.utf16Start = span.utf16_start;
    t.utf16End = span.utf16_end;
    t.level = SpanLevelName(span.level);
    t.sourceImageBufferId = imageBufferId;
    t.frameIndex = span.frame_index;
    for (int i = 0; i < 8; ++i) t.quad[i] = span.quad.xy[i];
    t.hasConfidence = true;
    t.confidence = span.confidence;
    t.origin = "ocr";
    out.push_back(t);
  }
  return out;
}

}  // namespace

@implementation SherpaOnnx (OCR)

- (void)detectOcrModel:(NSString *)modelDir
             modelType:(NSString *)modelType
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  @try {
    const std::string type =
        modelType.length > 0 ? [modelType UTF8String] : "auto";
    auto detect =
        DetectOcrModel(modelDir ? [modelDir UTF8String] : "", type);
    NSMutableDictionary *files = [NSMutableDictionary dictionary];
    NSMutableDictionary *paths = [NSMutableDictionary dictionary];
    if (!detect.detPath.empty()) {
      NSString *p = [NSString stringWithUTF8String:detect.detPath.c_str()];
      files[@"det"] = p;
      paths[@"det"] = p;
    }
    if (!detect.recPath.empty()) {
      NSString *p = [NSString stringWithUTF8String:detect.recPath.c_str()];
      files[@"rec"] = p;
      paths[@"rec"] = p;
    }
    if (!detect.clsPath.empty()) {
      NSString *p = [NSString stringWithUTF8String:detect.clsPath.c_str()];
      files[@"cls"] = p;
      paths[@"cls"] = p;
    }
    if (!detect.recDictPath.empty()) {
      NSString *p = [NSString stringWithUTF8String:detect.recDictPath.c_str()];
      files[@"recInferenceYml"] = p;
      paths[@"rec_dict"] = p;
    }
    if (!detect.manifestPath.empty()) {
      NSString *p = [NSString stringWithUTF8String:detect.manifestPath.c_str()];
      files[@"manifest"] = p;
      paths[@"manifest"] = p;
    }
    NSMutableArray *sources = [NSMutableArray array];
    for (const auto &src : detect.detectionSources) {
      [sources addObject:[NSString stringWithUTF8String:src.c_str()] ?: @""];
    }
    NSMutableArray *detectedModels = [NSMutableArray array];
    for (const auto &m : detect.detectedModels) {
      [detectedModels addObject:@{
        @"type" : [NSString stringWithUTF8String:m.type.c_str()] ?: @"",
        @"modelDir" : [NSString stringWithUTF8String:m.modelDir.c_str()] ?: @"",
      }];
    }
    NSMutableDictionary *out = [@{
      @"success" : @(detect.ok),
      @"ok" : @(detect.ok),
      @"hasDet" : @(detect.hasDet),
      @"hasRec" : @(detect.hasRec),
      @"hasCls" : @(detect.hasCls),
      @"hasRecYml" : @(detect.hasRecYml),
      @"files" : files,
      @"paths" : paths,
      @"detectionSources" : sources,
      @"detectedModels" : detectedModels,
    } mutableCopy];
    if (!detect.modelType.empty()) {
      out[@"modelType"] =
          [NSString stringWithUTF8String:detect.modelType.c_str()];
      out[@"family"] = [NSString stringWithUTF8String:detect.family.c_str()];
    }
    if (!detect.quantization.empty()) {
      out[@"quantization"] =
          [NSString stringWithUTF8String:detect.quantization.c_str()];
    }
    if (!detect.sizeTier.empty()) {
      out[@"sizeTier"] =
          [NSString stringWithUTF8String:detect.sizeTier.c_str()];
    }
    if (!detect.languages.empty()) {
      std::vector<sherpaonnx::PublicLanguageRow> rows;
      rows.reserve(detect.languages.size());
      for (const auto &lang : detect.languages) {
        rows.push_back(
            sherpaonnx::PublicLanguageRow{lang.iso6391Hint, lang.id});
      }
      out[@"languages"] =
          sherpaonnx::detect::bridge::PublicLanguageRowsToNSArray(rows);
    }
    if (!detect.errorCode.empty()) {
      out[@"errorCode"] = [NSString stringWithUTF8String:detect.errorCode.c_str()];
    }
    if (!detect.errorMessage.empty()) {
      NSString *msg =
          [NSString stringWithUTF8String:detect.errorMessage.c_str()];
      out[@"errorMessage"] = msg;
      out[@"error"] = msg;
    }
    resolve(out);
  } @catch (NSException *ex) {
    reject(kOcrInternal, ex.reason, nil);
  }
}

- (void)initializeOcr:(NSString *)instanceId
              options:(NSDictionary *)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  @try {
    try {
      NSString *modelDir = options[@"modelDir"];
      if (modelDir.length == 0) {
        reject(kOcrInvalidArg, @"modelDir is required", nil);
        return;
      }
      NSString *modelType = options[@"modelType"] ?: @"auto";
      int numThreads =
          options[@"numThreads"] ? [options[@"numThreads"] intValue] : 4;
      NSString *provider = options[@"provider"] ?: @"cpu";
      int maxSideLen =
          options[@"maxSideLen"] ? [options[@"maxSideLen"] intValue] : 960;
      BOOL useCls = options[@"useOrientationCls"]
                        ? [options[@"useOrientationCls"] boolValue]
                        : YES;
      float detBoxThresh =
          options[@"detBoxThresh"] ? [options[@"detBoxThresh"] floatValue] : 0.3f;
      float detBoxScoreThresh =
          options[@"detBoxScoreThresh"] ? [options[@"detBoxScoreThresh"] floatValue] : 0.5f;
      float detUnclipRatio =
          options[@"detUnclipRatio"] ? [options[@"detUnclipRatio"] floatValue] : 1.5f;

      std::string idStr = instanceId ? [instanceId UTF8String] : "";
      auto &engine = OcrEngineRegistry::Instance().Create(idStr);
      OcrLoadOptions opts;
      opts.num_threads = numThreads > 0 ? numThreads : 4;
      opts.max_side_len = maxSideLen > 0 ? maxSideLen : 960;
      opts.use_orientation_cls = useCls;
      opts.det_box_thresh = detBoxThresh;
      opts.det_box_score_thresh = detBoxScoreThresh;
      opts.det_unclip_ratio = detUnclipRatio;
      opts.provider = provider ? [provider UTF8String] : "cpu";
      engine.Load(modelType ? [modelType UTF8String] : "auto",
                  [modelDir UTF8String], opts);
      resolve(@{
        @"instanceId" : instanceId ?: @"",
        @"modelType" : modelType ?: @"auto",
      });
    } catch (const std::exception &e) {
      reject(kOcrInternal, [NSString stringWithUTF8String:e.what()], nil);
    }
  } @catch (NSException *ex) {
    reject(kOcrInternal, ex.reason, nil);
  }
}

- (void)ocrRecognize:(NSString *)instanceId
       imageBufferId:(NSString *)imageBufferId
     textOutBufferId:(NSString *)textOutBufferId
             options:(NSDictionary *)options
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  @try {
    try {
      std::string idStr = instanceId ? [instanceId UTF8String] : "";
      auto *engine = OcrEngineRegistry::Instance().Get(idStr);
      if (!engine) {
        reject(kOcrInstanceNotFound,
               [NSString
                   stringWithFormat:@"OCR instance not found: %@", instanceId],
               nil);
        return;
      }

      std::string textId = textOutBufferId ? [textOutBufferId UTF8String] : "";
      std::string existingText;
      std::string readErr;
      if (!txt_read_offline_text(textId, &existingText, &readErr)) {
        reject(@"TEXT_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:@"Offline text buffer not found: %@",
                                          textOutBufferId],
               nil);
        return;
      }

      NSString *operationId = options[@"operationId"];
      NSString *granularity = options[@"granularity"] ?: @"line";
      std::string opId = operationId ? [operationId UTF8String] : "";
      std::string imageId = imageBufferId ? [imageBufferId UTF8String] : "";

      OcrEngine::RecognizeOptions ropts;
      ropts.granularity = ParseGranularity(granularity);
      id framesObj = options[@"frames"];
      if ([framesObj isKindOfClass:[NSArray class]]) {
        for (id v in (NSArray *)framesObj) {
          ropts.frame_indices.push_back([v intValue]);
        }
      }
      if (!opId.empty()) {
        OcrCancelRegistry::Instance().Begin(opId);
        ropts.cancel = [opId]() {
          return OcrCancelRegistry::Instance().IsCancelled(opId);
        };
        __weak SherpaOnnx *weakSelf = self;
        ropts.progress = [weakSelf, operationId](int done, int total,
                                                 const std::string &phase) {
          EmitOcrProgress(weakSelf, operationId, done, total,
                          [NSString stringWithUTF8String:phase.c_str()]);
        };
      }

      auto outcome = engine->RecognizeMulti(imageId, ropts);
      if (!opId.empty()) {
        OcrCancelRegistry::Instance().End(opId);
      }

      if (outcome.cancelled) {
        reject(kOcrCancelled,
               [NSString stringWithUTF8String:outcome.errorMessage.c_str()],
               nil);
        return;
      }
      if (!outcome.ok) {
        NSString *code =
            outcome.errorCode.empty()
                ? kOcrRecognizeFailed
                : [NSString stringWithUTF8String:outcome.errorCode.c_str()];
        reject(code,
               [NSString stringWithUTF8String:outcome.errorMessage.c_str()],
               nil);
        return;
      }

      auto spans = MapSpansToTxt(outcome.result, imageId);
      std::string populateError;
      if (!txt_populate_offline_if_empty(
              textId, outcome.result.text_utf8, {}, {}, {}, "", "", "", spans,
              &populateError)) {
        reject(kOcrAlreadyPopulated,
               populateError.empty()
                   ? @"Text buffer already populated"
                   : [NSString stringWithUTF8String:populateError.c_str()],
               nil);
        return;
      }
      resolve(nil);
    } catch (const std::exception &e) {
      reject(kOcrInternal, [NSString stringWithUTF8String:e.what()], nil);
    }
  } @catch (NSException *ex) {
    reject(kOcrInternal, ex.reason, nil);
  }
}

- (void)cancelOcrRecognize:(NSString *)operationId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  OcrCancelRegistry::Instance().RequestCancel(
      operationId ? [operationId UTF8String] : "");
  resolve(nil);
}

- (void)unloadOcr:(NSString *)instanceId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  OcrEngineRegistry::Instance().Destroy(instanceId ? [instanceId UTF8String] : "");
  resolve(nil);
}

@end
