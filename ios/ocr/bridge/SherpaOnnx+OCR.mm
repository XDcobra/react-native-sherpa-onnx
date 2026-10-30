#import "../../SherpaOnnx.h"

#include "ImageRegistry.h"
#include "OcrCapabilities.h"
#include "OcrDetect.h"
#include "OcrEngine.h"
#include "OcrTypes.h"
#include "../../detect/native/sherpa-onnx-public-language-row-bridge.h"
#include "../../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h"
#include "../../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-validate-custom.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <map>
#include <mutex>
#include <string>
#include <vector>

using sherpa_onnx::image::ImageRegistry;
using sherpa_onnx::ocr::CapabilitiesForFamily;
using sherpa_onnx::ocr::DetectOcrModel;
using sherpa_onnx::ocr::GranularityName;
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
static NSString *kOcrInstructionFamilyMismatch =
    @"OCR_INSTRUCTION_FAMILY_MISMATCH";
static NSString *kOcrInstructionUnsupported = @"OCR_INSTRUCTION_UNSUPPORTED";
static NSString *kOcrInvalidRegion = @"OCR_INVALID_REGION";
static NSString *kOcrUnsupportedGranularity = @"OCR_UNSUPPORTED_GRANULARITY";
static NSString *kOcrInvalidRecognizeSpec = @"OCR_INVALID_RECOGNIZE_SPEC";
static NSString *kOcrParseUnknownKind = @"OCR_PARSE_UNKNOWN_KIND";
static NSString *kOcrCapabilitiesMismatch = @"OCR_CAPABILITIES_MISMATCH";

static void EmitOcrProgress(SherpaOnnx *bridge, NSString *operationId, int done,
                            int total, NSString *phase, int frameIndex,
                            int frameCount) {
  if (operationId.length == 0 || bridge == nil) return;
  std::lock_guard<std::mutex> lock(g_ocr_emit_mutex);
  [bridge sendEventWithName:@"SherpaOnnxOcrProgress"
                       body:@{
                         @"operationId" : operationId,
                         @"done" : @(done),
                         @"total" : @(total),
                         @"phase" : phase ?: @"recognize",
                         @"frameIndex" : @(frameIndex),
                         @"frameCount" : @(frameCount),
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
          quantization:(NSString *)quantization
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  @try {
    const std::string type =
        (modelType != nil && modelType.length > 0) ? [modelType UTF8String]
                                                   : "auto";
    const std::string quant =
        (quantization != nil && quantization.length > 0)
            ? [quantization UTF8String]
            : "";
    auto detect =
        DetectOcrModel(modelDir ? [modelDir UTF8String] : "", type, quant);
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
    if (!detect.visionEncoderPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.visionEncoderPath.c_str()];
      files[@"vision_encoder"] = p;
      paths[@"vision_encoder"] = p;
    }
    if (!detect.visionEncoderDataPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.visionEncoderDataPath.c_str()];
      files[@"vision_encoder_data"] = p;
      paths[@"vision_encoder_data"] = p;
    }
    if (!detect.embedTokensPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.embedTokensPath.c_str()];
      files[@"embed_tokens"] = p;
      paths[@"embed_tokens"] = p;
    }
    if (!detect.embedTokensDataPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.embedTokensDataPath.c_str()];
      files[@"embed_tokens_data"] = p;
      paths[@"embed_tokens_data"] = p;
    }
    if (!detect.embeddingPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.embeddingPath.c_str()];
      files[@"embedding"] = p;
      paths[@"embedding"] = p;
    }
    if (!detect.embeddingDataPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.embeddingDataPath.c_str()];
      files[@"embedding_data"] = p;
      paths[@"embedding_data"] = p;
    }
    if (!detect.decoderPath.empty()) {
      NSString *p = [NSString stringWithUTF8String:detect.decoderPath.c_str()];
      files[@"decoder"] = p;
      paths[@"decoder"] = p;
    }
    if (!detect.decoderDataPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.decoderDataPath.c_str()];
      files[@"decoder_data"] = p;
      paths[@"decoder_data"] = p;
    }
    if (!detect.tokenizerPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.tokenizerPath.c_str()];
      files[@"tokenizer"] = p;
      paths[@"tokenizer"] = p;
    }
    if (!detect.patchEmbedPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.patchEmbedPath.c_str()];
      files[@"patch_embed"] = p;
      paths[@"patch_embed"] = p;
    }
    if (!detect.patchEmbedDataPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.patchEmbedDataPath.c_str()];
      files[@"patch_embed_data"] = p;
      paths[@"patch_embed_data"] = p;
    }
    if (!detect.posEmbedPath.empty()) {
      NSString *p =
          [NSString stringWithUTF8String:detect.posEmbedPath.c_str()];
      files[@"pos_embed"] = p;
      paths[@"pos_embed"] = p;
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
      NSString *initMode = options[@"initMode"] ?: @"auto";
      NSString *modelType = options[@"modelType"] ?: @"auto";
      NSString *modelDir = options[@"modelDir"] ?: @"";
      NSDictionary *modelPaths =
          [options[@"modelPaths"] isKindOfClass:[NSDictionary class]]
              ? options[@"modelPaths"]
              : nil;

      const BOOL isCustom = [initMode isEqualToString:@"custom"];
      if (isCustom) {
        if (modelType.length == 0 || [modelType isEqualToString:@"auto"] ||
            (!([modelType isEqualToString:@"ppocr"] ||
               [modelType isEqualToString:@"doctr"] ||
               [modelType isEqualToString:@"doc_vlm"] ||
               [modelType isEqualToString:@"nemotron_parse"] ||
               [modelType isEqualToString:@"paddleocr_vl"]))) {
          reject(kOcrInvalidArg,
                 @"custom init requires a concrete modelType (ppocr|doctr|doc_vlm|nemotron_parse|paddleocr_vl)",
                 nil);
          return;
        }
        if (modelPaths == nil || modelPaths.count == 0) {
          reject(kOcrInvalidArg, @"modelPaths is required for initMode custom",
                 nil);
          return;
        }
        std::map<std::string, std::string> pathMap;
        for (NSString *key in modelPaths) {
          id val = modelPaths[key];
          if (![val isKindOfClass:[NSString class]]) continue;
          NSString *s = [(NSString *)val stringByTrimmingCharactersInSet:
                                             [NSCharacterSet whitespaceAndNewlineCharacterSet]];
          if (s.length == 0) continue;
          pathMap[[key UTF8String]] = [s UTF8String];
        }
        auto validation = sherpaonnx::ValidateCustomModelPaths(
            "ocr", [modelType UTF8String], pathMap, "custom");
        if (!validation.ok) {
          NSString *msg =
              validation.error.empty()
                  ? @"Invalid custom OCR model paths"
                  : [NSString stringWithUTF8String:validation.error.c_str()];
          reject(kOcrInvalidArg, msg, nil);
          return;
        }
        if (modelDir.length == 0) {
          for (NSString *prefer in @[ @"det", @"vision_encoder", @"manifest",
                                      @"rec", @"tokenizer" ]) {
            NSString *p = modelPaths[prefer];
            if ([p isKindOfClass:[NSString class]] && p.length > 0) {
              modelDir = [p stringByDeletingLastPathComponent];
              break;
            }
          }
          if (modelDir.length == 0) {
            NSString *any = modelPaths.allValues.firstObject;
            if ([any isKindOfClass:[NSString class]]) {
              modelDir = [any stringByDeletingLastPathComponent];
            }
          }
        }
      } else if (modelDir.length == 0) {
        reject(kOcrInvalidArg, @"modelDir is required", nil);
        return;
      }

      int numThreads =
          options[@"numThreads"] ? [options[@"numThreads"] intValue] : 4;
      NSString *provider = options[@"provider"] ?: @"cpu";
      int maxSideLen =
          options[@"maxSideLen"] ? [options[@"maxSideLen"] intValue] : 960;
      BOOL useCls = options[@"useOrientationCls"]
                        ? [options[@"useOrientationCls"] boolValue]
                        : YES;
      float detBoxThresh =
          options[@"detBoxThresh"] ? [options[@"detBoxThresh"] floatValue] : -1.f;
      float detBoxScoreThresh =
          options[@"detBoxScoreThresh"] ? [options[@"detBoxScoreThresh"] floatValue]
                                        : -1.f;
      float detUnclipRatio =
          options[@"detUnclipRatio"] ? [options[@"detUnclipRatio"] floatValue] : 1.5f;
      int maxNewTokens =
          options[@"maxNewTokens"] ? [options[@"maxNewTokens"] intValue] : 0;
      int maxPixels =
          options[@"maxPixels"] ? [options[@"maxPixels"] intValue] : 0;

      std::string idStr = instanceId ? [instanceId UTF8String] : "";
      auto &engine = OcrEngineRegistry::Instance().Create(idStr);
      OcrLoadOptions opts;
      opts.num_threads = numThreads > 0 ? numThreads : 4;
      opts.max_side_len = maxSideLen > 0 ? maxSideLen : 960;
      opts.use_orientation_cls = useCls;
      opts.det_box_thresh = detBoxThresh;
      opts.det_box_score_thresh = detBoxScoreThresh;
      opts.det_unclip_ratio = detUnclipRatio;
      opts.max_new_tokens = maxNewTokens;
      opts.max_pixels = maxPixels;
      opts.provider = provider ? [provider UTF8String] : "cpu";
      NSString *quantization = options[@"quantization"];
      if ([quantization isKindOfClass:[NSString class]] && quantization.length > 0) {
        opts.quantization = [quantization UTF8String];
      }
      if (isCustom && modelPaths != nil) {
        auto take = ^std::string(NSString *key) {
          id v = modelPaths[key];
          if (![v isKindOfClass:[NSString class]]) return {};
          return [(NSString *)v UTF8String];
        };
        opts.path_det = take(@"det");
        opts.path_rec = take(@"rec");
        opts.path_cls = take(@"cls");
        opts.path_rec_dict = take(@"rec_dict");
        opts.path_manifest = take(@"manifest");
        opts.path_vision_encoder = take(@"vision_encoder");
        opts.path_vision_encoder_data = take(@"vision_encoder_data");
        opts.path_embed_tokens = take(@"embed_tokens");
        opts.path_embed_tokens_data = take(@"embed_tokens_data");
        opts.path_embedding = take(@"embedding");
        opts.path_embedding_data = take(@"embedding_data");
        opts.path_decoder = take(@"decoder");
        opts.path_decoder_data = take(@"decoder_data");
        opts.path_tokenizer = take(@"tokenizer");
        opts.path_patch_embed = take(@"patch_embed");
        opts.path_patch_embed_data = take(@"patch_embed_data");
        opts.path_pos_embed = take(@"pos_embed");
      }
      engine.Load(modelType ? [modelType UTF8String] : "auto",
                  [modelDir UTF8String], opts);
      const char *familyC = engine.Family();
      NSString *family =
          (familyC && familyC[0] != '\0')
              ? [NSString stringWithUTF8String:familyC]
              : (modelType ?: @"auto");
      auto caps = CapabilitiesForFamily(family.UTF8String);
      NSMutableArray *tasks = [NSMutableArray array];
      for (const auto &task : caps.tasks) {
        [tasks addObject:[NSString stringWithUTF8String:task.c_str()]];
      }
      NSMutableArray *granularities = [NSMutableArray array];
      for (const auto g : caps.granularities) {
        [granularities
            addObject:[NSString stringWithUTF8String:GranularityName(g)]];
      }
      resolve(@{
        @"instanceId" : instanceId ?: @"",
        @"modelType" : family,
        @"tasks" : tasks,
        @"granularities" : granularities,
        @"supportsCrop" : @(caps.supports_crop),
        @"producesElements" : @(caps.produces_elements),
      });
    } catch (const std::exception &e) {
      reject(kOcrInternal, [NSString stringWithUTF8String:e.what()], nil);
    } catch (...) {
      reject(kOcrInternal, @"OCR load failed", nil);
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
      int progressMinIntervalMs = sherpa_onnx::ocr::kOcrProgressMinIntervalMs;
      id intervalObj = options[@"progressMinIntervalMs"];
      if ([intervalObj respondsToSelector:@selector(intValue)]) {
        int parsed = [intervalObj intValue];
        progressMinIntervalMs = parsed < 0 ? 0 : parsed;
      }

      OcrEngine::RecognizeOptions ropts;
      ropts.granularity = ParseGranularity(granularity);
      ropts.progress_min_interval_ms = progressMinIntervalMs;
      NSString *recognizeSpec = options[@"recognizeSpec"];
      if ([recognizeSpec isKindOfClass:[NSString class]] && recognizeSpec.length > 0) {
        ropts.recognize_spec = [recognizeSpec UTF8String];
      }
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
        ropts.progress = [weakSelf, operationId](
                             const sherpa_onnx::ocr::OcrProgressTick &tick) {
          EmitOcrProgress(weakSelf, operationId, tick.done, tick.total,
                          [NSString stringWithUTF8String:tick.phase.c_str()],
                          tick.frame_index, tick.frame_count);
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
      if (outcome.family.empty()) {
        reject(kOcrInternal, @"recognize result missing family", nil);
        return;
      }
      NSMutableDictionary *payload = [@{
        @"family" : [NSString stringWithUTF8String:outcome.family.c_str()] ?: @"",
        @"spanCount" : @(static_cast<NSInteger>(spans.size())),
        @"raw" : [NSString stringWithUTF8String:outcome.result.raw_utf8.c_str()]
            ?: @"",
        @"instructionSpec" :
            [NSString stringWithUTF8String:outcome.result.instruction_spec.c_str()]
            ?: @"",
      } mutableCopy];
      if (sherpa_onnx::ocr::IsOcrVlmFamily(outcome.family)) {
        payload[@"stopReason"] =
            [NSString stringWithUTF8String:outcome.result.stop_reason.c_str()] ?: @"";
        payload[@"complete"] = @(outcome.result.complete);
      }
      if (outcome.result.has_content) {
        NSMutableDictionary *content = [@{
          @"format" : [NSString stringWithUTF8String:sherpa_onnx::ocr::OcrContentFormatName(
                          outcome.result.content.format)]
              ?: @"markdown",
          @"value" : [NSString stringWithUTF8String:outcome.result.content.value.c_str()]
              ?: @"",
        } mutableCopy];
        if (!outcome.result.content.language.empty()) {
          content[@"language"] =
              [NSString stringWithUTF8String:outcome.result.content.language.c_str()] ?: @"";
        }
        payload[@"content"] = content;
      }
      NSMutableArray *elements = [NSMutableArray arrayWithCapacity:outcome.result.elements.size()];
      for (const auto &element : outcome.result.elements) {
        NSMutableDictionary *el = [@{
          @"kind" : [NSString stringWithUTF8String:sherpa_onnx::ocr::OcrElementKindName(
                        element.kind)]
              ?: @"text",
          @"frameIndex" : @(element.frame_index),
        } mutableCopy];
        if (element.has_quad) {
          NSMutableArray *quad = [NSMutableArray arrayWithCapacity:8];
          for (int i = 0; i < 8; ++i) {
            [quad addObject:@(element.quad.xy[i])];
          }
          el[@"quad"] = quad;
        }
        if (element.has_utf16) {
          el[@"utf16Start"] = @(element.utf16_start);
          el[@"utf16End"] = @(element.utf16_end);
        }
        if (element.heading_level) {
          el[@"headingLevel"] = @(*element.heading_level);
        }
        if (element.checked) {
          el[@"checked"] = @(*element.checked);
        }
        [elements addObject:el];
      }
      payload[@"elements"] = elements;
      resolve(payload);
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
