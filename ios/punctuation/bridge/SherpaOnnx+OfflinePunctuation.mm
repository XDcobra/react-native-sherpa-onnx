#import "../../SherpaOnnx.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../pipeline/PunctuationOfflineLivePipelineWorker.h"
#include "../core/PunctuationTextInputNormalization.hpp"

#include <CoreFoundation/CoreFoundation.h>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

std::mutex g_punct_offline_mutex;
std::map<std::string, sherpa_onnx::cxx::OfflinePunctuation> g_punct_offline;

static NSString *kInitErr = @"PUNCTUATION_INIT_ERROR";
static NSString *kPunctErr = @"PUNCTUATION_ERROR";
static NSString *kNotFound = @"PUNCTUATION_INSTANCE_NOT_FOUND";
static NSString *kInvalidArg = @"PUNCTUATION_INVALID_ARGUMENT";
static NSString *kTxtNotFound = @"TEXT_BUFFER_NOT_FOUND";
static NSString *kTxtKind = @"TEXT_BUFFER_KIND_MISMATCH";
static NSString *kTxtEmpty = @"TEXT_BUFFER_EMPTY";
static NSString *kTxtPop = @"TEXT_ALREADY_POPULATED";

}  // namespace

extern "C" void sherpaonnx_punct_offline_invalidate_all(void) {
  std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
  g_punct_offline.clear();
}

extern "C" bool sherpaonnx_punct_offline_add_punctuation_if_exists(
    const std::string &instanceId,
    const std::string &text,
    std::string *outText) {
  sherpa_onnx::cxx::OfflinePunctuation *engine = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
    auto it = g_punct_offline.find(instanceId);
    if (it == g_punct_offline.end()) {
      return false;
    }
    engine = &it->second;
  }
  if (outText != nullptr) {
    const std::string normalized =
        punct_text_input_normalization::normalize(text, "lower");
    *outText = engine->AddPunctuation(normalized);
  }
  return true;
}

extern "C" bool sherpaonnx_punct_offline_has_instance(
    const std::string &instanceId) {
  std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
  return g_punct_offline.find(instanceId) != g_punct_offline.end();
}

@implementation SherpaOnnx (OfflinePunctuation)

- (void)initializeOfflinePunctuation:(NSString *)instanceId
                            modelDir:(NSString *)modelDir
                           modelType:(NSString *)modelType
                          numThreads:(NSNumber *)numThreads
                            provider:(NSString *)provider
                               debug:(NSNumber *)debug
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(kInitErr, @"instanceId is required", nil);
    return;
  }
  if (modelDir == nil || [modelDir length] == 0) {
    reject(kInitErr, @"modelDir is required", nil);
    return;
  }
  if (modelType != nil) {
    NSString *trimmed =
        [modelType stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSString *req = [trimmed lowercaseString];
    if (!([req isEqualToString:@"auto"] || [req isEqualToString:@"ct_transformer"])) {
      reject(kInitErr,
             [NSString stringWithFormat:@"Unsupported modelType for offline engine: %@", modelType],
             nil);
      return;
    }
  }
  std::string idStr = [instanceId UTF8String];
  std::string dirStr = [modelDir UTF8String];

  @try {
    auto det = sherpaonnx::DetectPunctuationModel(
        std::optional<std::string>(dirStr),
        std::nullopt,
        "ct_transformer");
    if (!det.ok) {
      NSString *msg = det.error.empty()
          ? @"Punctuation: model is not a valid offline CT-Transformer layout"
          : [NSString stringWithUTF8String:det.error.c_str()];
      reject(kInitErr, msg, nil);
      return;
    }
    if (det.selectedKind != sherpaonnx::PunctuationModelKind::kCtTransformer) {
      reject(kInitErr, @"Offline punctuation requires ct_transformer (native detect mismatch)", nil);
      return;
    }
    if (det.paths.ct_transformer.empty()) {
      reject(kInitErr, @"Punctuation: missing ct_transformer onnx path", nil);
      return;
    }
    int32_t nt = numThreads != nil ? (int32_t)[numThreads intValue] : 1;
    if (nt < 1) {
      nt = 1;
    }
    bool dbg = debug != nil && [debug boolValue];
    std::string prov = "cpu";
    if (provider != nil && [provider length] > 0) {
      prov = std::string([provider UTF8String]);
    }

    sherpa_onnx::cxx::OfflinePunctuationConfig cfg;
    cfg.model.ct_transformer = det.paths.ct_transformer;
    cfg.model.num_threads = nt;
    cfg.model.debug = dbg;
    cfg.model.provider = prov;

    auto created = sherpa_onnx::cxx::OfflinePunctuation::Create(cfg);
    {
      std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
      g_punct_offline.erase(idStr);
      g_punct_offline.emplace(idStr, std::move(created));
    }

    NSMutableArray *models = [NSMutableArray array];
    for (const auto &m : det.detectedModels) {
      [models addObject:@ {
        @"type" : [NSString stringWithUTF8String:m.type.c_str()] ?: @"",
        @"modelDir" : [NSString stringWithUTF8String:m.modelDir.c_str()] ?: @""
      }];
    }
    resolve(@{
      @"success" : @YES,
      @"modelType" : @"ct_transformer",
      @"detectedModels" : models
    });
  } @catch (NSException *exception) {
    reject(kInitErr, [NSString stringWithFormat:@"Offline punctuation init: %@", exception.reason], nil);
  }
}

- (void)punctuateOfflineTextBuffers:(NSString *)instanceId
                   textInBufferId:(NSString *)textInId
                  textOutBufferId:(NSString *)textOutId
               textInputNormalization:(NSString *)textInputNormalization
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(kPunctErr, @"instanceId is required", nil);
    return;
  }
  std::string iid = [instanceId UTF8String];
  sherpa_onnx::cxx::OfflinePunctuation *eng = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
    auto it = g_punct_offline.find(iid);
    if (it == g_punct_offline.end()) {
      reject(kNotFound, [NSString stringWithFormat:@"Offline punctuation instance not found: %@", instanceId], nil);
      return;
    }
    eng = &it->second;
  }
  if (textInId == nil || [textInId hasPrefix:@"txt_off_"] == NO) {
    reject(kTxtKind, [NSString stringWithFormat:@"Expected txt_off_* for text in, got %@", textInId], nil);
    return;
  }
  if (textOutId == nil || [textOutId hasPrefix:@"txt_off_"] == NO) {
    reject(kTxtKind, [NSString stringWithFormat:@"Expected txt_off_* for text out, got %@", textOutId], nil);
    return;
  }
  std::string plain;
  std::string lang;
  {
    std::string inId = std::string([textInId UTF8String]);
    std::string err;
    if (!txt_read_offline_text_with_lang(inId, &plain, &lang, &err)) {
      NSString *c = kTxtNotFound;
      if (err.find("not found") == std::string::npos) {
        c = kTxtEmpty;
      }
      reject(c, [NSString stringWithUTF8String:err.c_str()], nil);
      return;
    }
  }
  std::string outId = std::string([textOutId UTF8String]);
  {
    std::lock_guard<std::mutex> tlock(g_txt_mutex);
    auto oi = g_txt_offline.find(outId);
    if (oi == g_txt_offline.end() || !oi->second) {
      reject(kTxtNotFound, [NSString stringWithFormat:@"Output buffer not found: %@", textOutId], nil);
      return;
    }
  }
  const std::string normalization =
      punct_text_input_normalization::resolve_mode(textInputNormalization);
  const std::string normalizedPlain =
      punct_text_input_normalization::normalize(plain, normalization);
  CFTimeInterval t0 = CFAbsoluteTimeGetCurrent();
  std::string outText;
  @try {
    outText = eng->AddPunctuation(normalizedPlain);
  } @catch (NSException *exception) {
    reject(kPunctErr, [NSString stringWithFormat:@"Punctuation: %@", exception.reason], nil);
    return;
  }
  CFTimeInterval t1 = CFAbsoluteTimeGetCurrent();
  double ms = (t1 - t0) * 1000.0;
  std::string perr;
  if (!txt_populate_offline_if_empty(
          outId,
          outText,
          {},
          {},
          {},
          lang,
          "",
          "",
          &perr)) {
    reject(kTxtPop, [NSString stringWithUTF8String:perr.c_str()], nil);
    return;
  }
  resolve(@{@"processingTimeMs" : @(ms)});
}

- (void)punctuateOfflineString:(NSString *)instanceId
                        plain:(NSString *)plain
               textOutBufferId:(NSString *)textOutId
               textInputNormalization:(NSString *)textInputNormalization
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(kPunctErr, @"instanceId is required", nil);
    return;
  }
  if (plain == nil) {
    reject(kPunctErr, @"plain is required", nil);
    return;
  }
  std::string iid = [instanceId UTF8String];
  sherpa_onnx::cxx::OfflinePunctuation *eng = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
    auto it = g_punct_offline.find(iid);
    if (it == g_punct_offline.end()) {
      reject(kNotFound, [NSString stringWithFormat:@"Offline punctuation instance not found: %@", instanceId], nil);
      return;
    }
    eng = &it->second;
  }
  if (textOutId == nil || [textOutId hasPrefix:@"txt_off_"] == NO) {
    reject(kTxtKind, [NSString stringWithFormat:@"Expected txt_off_* for text out, got %@", textOutId], nil);
    return;
  }
  std::string outId = std::string([textOutId UTF8String]);
  {
    std::lock_guard<std::mutex> tlock(g_txt_mutex);
    auto oi = g_txt_offline.find(outId);
    if (oi == g_txt_offline.end() || !oi->second) {
      reject(kTxtNotFound, [NSString stringWithFormat:@"Output buffer not found: %@", textOutId], nil);
      return;
    }
  }
  const std::string normalization =
      punct_text_input_normalization::resolve_mode(textInputNormalization);
  const std::string plainStr =
      punct_text_input_normalization::normalize([plain UTF8String], normalization);
  CFTimeInterval t0 = CFAbsoluteTimeGetCurrent();
  std::string outText;
  @try {
    outText = eng->AddPunctuation(plainStr);
  } @catch (NSException *exception) {
    reject(kPunctErr, [NSString stringWithFormat:@"Punctuation: %@", exception.reason], nil);
    return;
  }
  CFTimeInterval t1 = CFAbsoluteTimeGetCurrent();
  double ms = (t1 - t0) * 1000.0;
  std::string perr;
  if (!txt_populate_offline_if_empty(
          outId,
          outText,
          {},
          {},
          {},
          "",
          "",
          "",
          &perr)) {
    reject(kTxtPop, [NSString stringWithUTF8String:perr.c_str()], nil);
    return;
  }
  resolve(@{@"processingTimeMs" : @(ms)});
}

- (void)unloadOfflinePunctuation:(NSString *)instanceId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  std::string iid = [instanceId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
    g_punct_offline.erase(iid);
  }
  resolve(nil);
}

- (void)startPunctuationOfflineLivePipeline:(NSString *)instanceId
                          textInLiveBufferId:(NSString *)textInLiveBufferId
                         textOutLiveBufferId:(NSString *)textOutLiveBufferId
                                     options:(JS::NativeSherpaOnnx::SpecStartPunctuationOfflineLivePipelineOptions &)options
                                     resolve:(RCTPromiseResolveBlock)resolve
                                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(kInvalidArg, @"instanceId is required", nil);
    return;
  }
  if (textInLiveBufferId == nil || [textInLiveBufferId length] == 0) {
    reject(kInvalidArg, @"textInLiveBufferId is required", nil);
    return;
  }
  if (textOutLiveBufferId == nil || [textOutLiveBufferId length] == 0) {
    reject(kInvalidArg, @"textOutLiveBufferId is required", nil);
    return;
  }

  NSString *attachedSegmentationEngineId = options.attachedSegmentationEngineId();
  if (attachedSegmentationEngineId == nil || [attachedSegmentationEngineId length] == 0) {
    reject(kInvalidArg, @"options.attachedSegmentationEngineId is required", nil);
    return;
  }

  NSString *segmentLiveBufferId = options.segmentLiveBufferId();
  if (segmentLiveBufferId == nil || [segmentLiveBufferId length] == 0) {
    reject(kInvalidArg, @"options.segmentLiveBufferId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string textInIdStr = [textInLiveBufferId UTF8String];
  std::string textOutIdStr = [textOutLiveBufferId UTF8String];
  std::string attachedEngineIdStr = [attachedSegmentationEngineId UTF8String];
  std::string segmentBufferIdStr = [segmentLiveBufferId UTF8String];

  {
    std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
    auto it = g_punct_offline.find(instanceIdStr);
    if (it == g_punct_offline.end()) {
      reject(kNotFound,
             [NSString stringWithFormat:@"Offline punctuation instance not found: %@", instanceId],
             nil);
      return;
    }
  }

  auto textInputEntry = txt_get_live_entry(textInIdStr);
  if (!textInputEntry) {
    reject(kTxtNotFound,
           [NSString stringWithFormat:@"Input live text buffer not found: %@", textInLiveBufferId],
           nil);
    return;
  }

  if (!txt_live_is_recording(textInputEntry)) {
    reject(kInvalidArg,
           [NSString stringWithFormat:@"Input live text buffer is not in recording state: %@", textInLiveBufferId],
           nil);
    return;
  }

  auto textOutputEntry = txt_get_live_entry(textOutIdStr);
  if (!textOutputEntry) {
    reject(kTxtNotFound,
           [NSString stringWithFormat:@"Output live text buffer not found: %@", textOutLiveBufferId],
           nil);
    return;
  }

  if (!txt_live_is_recording(textOutputEntry)) {
    reject(kInvalidArg,
           [NSString stringWithFormat:@"Output live text buffer is not in recording state: %@", textOutLiveBufferId],
           nil);
    return;
  }

  auto segmentInputEntry = seg_get_live_entry(segmentBufferIdStr);
  if (!segmentInputEntry) {
    reject(kInvalidArg,
           [NSString stringWithFormat:@"Input live segment buffer not found: %@", segmentLiveBufferId],
           nil);
    return;
  }

  (void)segmentInputEntry;

  try {
    std::string pipelineId = std::string("punct_offline_live_") +
      std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    auto worker = std::make_shared<PunctuationOfflineLivePipelineWorker>(
      pipelineId,
      attachedEngineIdStr,
      textInputEntry,
      segmentBufferIdStr,
      textOutputEntry,
      instanceIdStr
    );

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      g_streaming_pipelines[pipelineId] = worker;
    }

    worker->start();
    so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

    resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] ?: @"" });
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()] ?: @"Failed to start live offline punctuation pipeline";
    reject(kPunctErr, msg, nil);
  } catch (...) {
    reject(kPunctErr, @"Failed to start live offline punctuation pipeline", nil);
  }
}

@end
