#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../core/SpeakerEmbeddingBridgeState.h"
#include "../core/SpeakerEmbeddingBridgeUtils.h"
#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include "sherpa-onnx-model-path-fill.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

dispatch_queue_t SpeakerEmbeddingSerialQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.speakerembedding", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

void FillSpeakerEmbeddingModelPathsFromDict(
    NSDictionary *dict,
    sherpaonnx::SpeakerEmbeddingModelPaths &paths) {
  if (![dict isKindOfClass:[NSDictionary class]]) {
    return;
  }
  std::map<std::string, std::string> pathMap;
  for (NSString *key in dict) {
    id value = dict[key];
    if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
      pathMap[std::string([key UTF8String])] =
          std::string([(NSString *)value UTF8String]);
    }
  }
  sherpaonnx::FillSpeakerEmbeddingModelPathsFromStringMap(pathMap, paths);
}

struct SpeakerEmbeddingInitScalars {
  int32_t numThreads = 1;
  bool debug = false;
  std::optional<std::string> provider;
};

SpeakerEmbeddingInitScalars ParseSpeakerEmbeddingInitScalars(
    const JS::NativeSherpaOnnx::SpeakerEmbeddingInitBridgeOptions &options) {
  SpeakerEmbeddingInitScalars scalars;
  auto numThreads = options.numThreads();
  if (numThreads.has_value()) {
    scalars.numThreads = MAX(1, (int32_t)numThreads.value());
  }
  auto debug = options.debug();
  if (debug.has_value()) {
    scalars.debug = debug.value();
  }
  scalars.provider = OptionalUtf8String(options.provider());
  return scalars;
}

std::vector<float> NSArrayToFloatVector(NSArray *arr) {
  std::vector<float> out;
  if (arr == nil) return out;
  out.reserve([arr count]);
  for (id value in arr) {
    if ([value isKindOfClass:[NSNumber class]]) {
      out.push_back([(NSNumber *)value floatValue]);
    } else {
      out.push_back(0.f);
    }
  }
  return out;
}

NSArray *FloatVectorToNSArray(const std::vector<float> &values) {
  NSMutableArray *arr = [NSMutableArray arrayWithCapacity:values.size()];
  for (float v : values) {
    [arr addObject:@(v)];
  }
  return arr;
}

}  // namespace

@implementation SherpaOnnx (SpeakerEmbedding)

- (void)initializeSpeakerEmbeddingExtractor:(NSString *)instanceId
                                    options:(JS::NativeSherpaOnnx::SpeakerEmbeddingInitBridgeOptions &)options
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *initMode = options.initMode();
  if (initMode == nil || [initMode length] == 0) {
    initMode = @"auto";
  }
  const bool isCustomInit = [initMode isEqualToString:@"custom"];
  const std::string instanceIdStr = [instanceId UTF8String];
  const SpeakerEmbeddingInitScalars scalars = ParseSpeakerEmbeddingInitScalars(options);

  @try {
    // Validate custom/auto args before allocating a wrapper under the map lock.
    sherpaonnx::SpeakerEmbeddingModelPaths customPaths;
    std::string customModelType;
    std::string autoModelDir;
    std::string autoModelType;
    if (isCustomInit) {
      NSString *modelType = options.modelType();
      if (modelType == nil || [modelType length] == 0 ||
          [modelType isEqualToString:@"auto"]) {
        reject(@"SPEAKER_EMBEDDING_INIT_ERROR",
               @"custom init requires a concrete modelType", nil);
        return;
      }
      id modelPathsObj = options.modelPaths();
      if (![modelPathsObj isKindOfClass:[NSDictionary class]]) {
        reject(@"SPEAKER_EMBEDDING_INIT_ERROR",
               @"custom init requires modelPaths", nil);
        return;
      }
      customModelType = std::string([modelType UTF8String]);
      FillSpeakerEmbeddingModelPathsFromDict((NSDictionary *)modelPathsObj, customPaths);
    } else {
      NSString *modelDir = options.modelDir();
      if (modelDir == nil || [modelDir length] == 0) {
        reject(@"SPEAKER_EMBEDDING_INIT_ERROR",
               @"modelDir is required for initMode auto", nil);
        return;
      }
      autoModelDir = std::string([modelDir UTF8String]);
      autoModelType = sherpaonnx::speaker_embedding::bridge::ModelTypeOrAuto(
          options.modelType());
    }

    std::lock_guard<std::mutex> lock(
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
    // Replace the map entry so in-flight shared_ptrs keep the old wrapper.
    auto inst = std::make_shared<sherpaonnx::SpeakerEmbeddingExtractorWrapper>();

    sherpaonnx::SpeakerEmbeddingInitializeResult result;
    if (isCustomInit) {
      result = inst->initializeCustom(
          customModelType,
          customPaths,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    } else {
      result = inst->initialize(
          autoModelDir,
          autoModelType,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    }

    if (!result.success) {
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors.erase(
          instanceIdStr);
      NSString *errorMsg = result.error.empty()
          ? @"Failed to initialize speaker embedding extractor"
          : [NSString stringWithUTF8String:result.error.c_str()];
      reject(@"SPEAKER_EMBEDDING_INIT_ERROR", errorMsg, nil);
      return;
    }

    sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors[instanceIdStr] =
        std::move(inst);

    resolve(@{
      @"success": @YES,
      @"dim": @(result.dim),
      @"modelType": [NSString stringWithUTF8String:result.modelType.c_str()] ?: @"unknown"
    });
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_INIT_ERROR",
           [NSString stringWithFormat:@"Speaker embedding init failed: %@", exception.reason],
           nil);
  }
}

- (void)computeSpeakerEmbeddingOffline:(NSString *)instanceId
                        audioBufferId:(NSString *)audioBufferId
                          startSample:(NSNumber *)startSample
                            endSample:(NSNumber *)endSample
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"instanceId is required", nil);
    return;
  }
  if (audioBufferId == nil || [audioBufferId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"audioBufferId is required", nil);
    return;
  }

  const bool hasStart = startSample != nil;
  const bool hasEnd = endSample != nil;
  if (hasStart != hasEnd) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           @"startSample and endSample must both be provided or both omitted",
           nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string audioInId = [audioBufferId UTF8String];
  if (audioInId.find("off_") != 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioBufferId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
           nil);
    return;
  }

  @try {
    std::vector<float> inputSamples;
    int inputSr = inSampleRate;

    if (!hasStart) {
      if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
        reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
               nil);
        return;
      }
    } else {
      const int start = std::max(0, static_cast<int>(std::floor([startSample doubleValue])));
      const int endRaw = std::max(start, static_cast<int>(std::floor([endSample doubleValue])));
      const int end = std::min(endRaw, inNumSamples);
      const int frameCount = std::max(0, end - start);
      if (frameCount == 0) {
        resolve(@{ @"embedding": @[] });
        return;
      }
      std::string sliceErrCode;
      std::string sliceErrMsg;
      if (!pa_get_offline_samples_slice(
              audioInId, start, frameCount, &inputSamples, &sliceErrCode, &sliceErrMsg)) {
        NSString *code = sliceErrCode.empty()
            ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
            : [NSString stringWithUTF8String:sliceErrCode.c_str()];
        NSString *msg = sliceErrMsg.empty()
            ? @"Failed to read offline audio slice"
            : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
        reject(code, msg, nil);
        return;
      }
    }

    auto extractor =
        sherpaonnx::speaker_embedding::bridge::LookupExtractor(instanceIdStr);
    if (!extractor || !extractor->isInitialized()) {
      reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
             [NSString stringWithFormat:@"Speaker embedding extractor not found: %@", instanceId],
             nil);
      return;
    }
    std::vector<float> embedding =
        extractor->computeFromSamples(inputSamples, inputSr);
    if (embedding.empty()) {
      const std::string &computeError = extractor->lastError();
      const std::string &computeErrorCode = extractor->lastErrorCode();
      NSString *code = computeErrorCode.empty()
          ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
          : [NSString stringWithUTF8String:computeErrorCode.c_str()];
      NSString *msg = computeError.empty()
          ? @"Speaker embedding compute failed"
          : [NSString stringWithUTF8String:computeError.c_str()];
      reject(code, msg, nil);
      return;
    }

    resolve(@{ @"embedding": FloatVectorToNSArray(embedding) });
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
           [NSString stringWithFormat:@"Speaker embedding compute failed: %@", exception.reason],
           nil);
  }
}

- (void)identifySpeakerOffline:(NSString *)instanceId
                     managerId:(NSString *)managerId
                 audioBufferId:(NSString *)audioBufferId
                     threshold:(double)threshold
                   startSample:(NSNumber *)startSample
                     endSample:(NSNumber *)endSample
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"instanceId is required", nil);
    return;
  }
  if (managerId == nil || [managerId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  if (audioBufferId == nil || [audioBufferId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"audioBufferId is required", nil);
    return;
  }

  const bool hasStart = startSample != nil;
  const bool hasEnd = endSample != nil;
  if (hasStart != hasEnd) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           @"startSample and endSample must both be provided or both omitted",
           nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string managerIdStr = [managerId UTF8String];
  const std::string audioInId = [audioBufferId UTF8String];
  if (audioInId.find("off_") != 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioBufferId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
           nil);
    return;
  }

  @try {
    std::vector<float> inputSamples;
    int inputSr = inSampleRate;

    if (!hasStart) {
      if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
        reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
               nil);
        return;
      }
    } else {
      const int start = std::max(0, static_cast<int>(std::floor([startSample doubleValue])));
      const int endRaw = std::max(start, static_cast<int>(std::floor([endSample doubleValue])));
      const int end = std::min(endRaw, inNumSamples);
      const int frameCount = std::max(0, end - start);
      if (frameCount == 0) {
        resolve(@{ @"name": @"" });
        return;
      }
      std::string sliceErrCode;
      std::string sliceErrMsg;
      if (!pa_get_offline_samples_slice(
              audioInId, start, frameCount, &inputSamples, &sliceErrCode, &sliceErrMsg)) {
        NSString *code = sliceErrCode.empty()
            ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
            : [NSString stringWithUTF8String:sliceErrCode.c_str()];
        NSString *msg = sliceErrMsg.empty()
            ? @"Failed to read offline audio slice"
            : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
        reject(code, msg, nil);
        return;
      }
    }

    auto extractor =
        sherpaonnx::speaker_embedding::bridge::LookupExtractor(instanceIdStr);
    if (!extractor || !extractor->isInitialized()) {
      reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
             [NSString stringWithFormat:@"Speaker embedding extractor not found: %@", instanceId],
             nil);
      return;
    }
    auto manager =
        sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
    if (!manager) {
      reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
             [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
             nil);
      return;
    }
    std::vector<float> embedding =
        extractor->computeFromSamples(inputSamples, inputSr);
    if (embedding.empty()) {
      const std::string &computeError = extractor->lastError();
      const std::string &computeErrorCode = extractor->lastErrorCode();
      NSString *code = computeErrorCode.empty()
          ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
          : [NSString stringWithUTF8String:computeErrorCode.c_str()];
      NSString *msg = computeError.empty()
          ? @"Speaker embedding compute failed"
          : [NSString stringWithUTF8String:computeError.c_str()];
      reject(code, msg, nil);
      return;
    }
    std::string matchedName =
        manager->search(embedding, static_cast<float>(threshold));

    resolve(@{
      @"name": [NSString stringWithUTF8String:matchedName.c_str()] ?: @""
    });
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
           [NSString stringWithFormat:@"Speaker identify offline failed: %@", exception.reason],
           nil);
  }
}

- (void)verifySpeakerOffline:(NSString *)instanceId
                   managerId:(NSString *)managerId
               audioBufferId:(NSString *)audioBufferId
                        name:(NSString *)name
                   threshold:(double)threshold
                 startSample:(NSNumber *)startSample
                   endSample:(NSNumber *)endSample
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"instanceId is required", nil);
    return;
  }
  if (managerId == nil || [managerId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  if (name == nil || [name length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"name is required", nil);
    return;
  }
  if (audioBufferId == nil || [audioBufferId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"audioBufferId is required", nil);
    return;
  }

  const bool hasStart = startSample != nil;
  const bool hasEnd = endSample != nil;
  if (hasStart != hasEnd) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           @"startSample and endSample must both be provided or both omitted",
           nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string managerIdStr = [managerId UTF8String];
  const std::string nameStr = [name UTF8String];
  const std::string audioInId = [audioBufferId UTF8String];
  if (audioInId.find("off_") != 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioBufferId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
           nil);
    return;
  }

  @try {
    std::vector<float> inputSamples;
    int inputSr = inSampleRate;

    if (!hasStart) {
      if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
        reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
               nil);
        return;
      }
    } else {
      const int start = std::max(0, static_cast<int>(std::floor([startSample doubleValue])));
      const int endRaw = std::max(start, static_cast<int>(std::floor([endSample doubleValue])));
      const int end = std::min(endRaw, inNumSamples);
      const int frameCount = std::max(0, end - start);
      if (frameCount == 0) {
        resolve(@{ @"ok": @NO });
        return;
      }
      std::string sliceErrCode;
      std::string sliceErrMsg;
      if (!pa_get_offline_samples_slice(
              audioInId, start, frameCount, &inputSamples, &sliceErrCode, &sliceErrMsg)) {
        NSString *code = sliceErrCode.empty()
            ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
            : [NSString stringWithUTF8String:sliceErrCode.c_str()];
        NSString *msg = sliceErrMsg.empty()
            ? @"Failed to read offline audio slice"
            : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
        reject(code, msg, nil);
        return;
      }
    }

    auto extractor =
        sherpaonnx::speaker_embedding::bridge::LookupExtractor(instanceIdStr);
    if (!extractor || !extractor->isInitialized()) {
      reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
             [NSString stringWithFormat:@"Speaker embedding extractor not found: %@", instanceId],
             nil);
      return;
    }
    auto manager =
        sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
    if (!manager) {
      reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
             [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
             nil);
      return;
    }
    std::vector<float> embedding =
        extractor->computeFromSamples(inputSamples, inputSr);
    if (embedding.empty()) {
      const std::string &computeError = extractor->lastError();
      const std::string &computeErrorCode = extractor->lastErrorCode();
      NSString *code = computeErrorCode.empty()
          ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
          : [NSString stringWithUTF8String:computeErrorCode.c_str()];
      NSString *msg = computeError.empty()
          ? @"Speaker embedding compute failed"
          : [NSString stringWithUTF8String:computeError.c_str()];
      reject(code, msg, nil);
      return;
    }
    bool verified =
        manager->verify(nameStr, embedding, static_cast<float>(threshold));

    resolve(@{ @"ok": @(verified) });
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
           [NSString stringWithFormat:@"Speaker verify offline failed: %@", exception.reason],
           nil);
  }
}

- (void)enrollSpeakerOffline:(NSString *)instanceId
                   managerId:(NSString *)managerId
                        name:(NSString *)name
              audioBufferIds:(NSArray *)audioBufferIds
                startSamples:(NSArray *)startSamples
                  endSamples:(NSArray *)endSamples
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"instanceId is required", nil);
    return;
  }
  if (managerId == nil || [managerId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  if (name == nil || [name length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"name is required", nil);
    return;
  }
  if (audioBufferIds == nil || ![audioBufferIds isKindOfClass:[NSArray class]] ||
      [audioBufferIds count] == 0) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           @"audioBufferIds must contain at least one buffer id", nil);
    return;
  }

  const NSUInteger countIds = [audioBufferIds count];
  const bool hasStarts = startSamples != nil && ![startSamples isEqual:[NSNull null]];
  const bool hasEnds = endSamples != nil && ![endSamples isEqual:[NSNull null]];
  if (hasStarts != hasEnds) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           @"startSamples and endSamples must both be provided or both omitted",
           nil);
    return;
  }
  if (hasStarts) {
    if (![startSamples isKindOfClass:[NSArray class]] ||
        ![endSamples isKindOfClass:[NSArray class]] ||
        [startSamples count] != countIds || [endSamples count] != countIds) {
      reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
             @"startSamples and endSamples must match audioBufferIds length",
             nil);
      return;
    }
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string managerIdStr = [managerId UTF8String];
  const std::string nameStr = [name UTF8String];

  @try {
    auto extractor =
        sherpaonnx::speaker_embedding::bridge::LookupExtractor(instanceIdStr);
    if (!extractor || !extractor->isInitialized()) {
      reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
             [NSString stringWithFormat:@"Speaker embedding extractor not found: %@", instanceId],
             nil);
      return;
    }
    auto manager =
        sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
    if (!manager || !manager->isInitialized()) {
      reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
             [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
             nil);
      return;
    }

    std::vector<std::vector<float>> embeddings;
    embeddings.reserve(countIds);

    for (NSUInteger i = 0; i < countIds; i++) {
      id idObj = audioBufferIds[i];
      if (![idObj isKindOfClass:[NSString class]] || [(NSString *)idObj length] == 0) {
        reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
               [NSString stringWithFormat:@"audioBufferIds[%lu] is required", (unsigned long)i],
               nil);
        return;
      }
      NSString *audioBufferId = (NSString *)idObj;
      const std::string audioInId = [audioBufferId UTF8String];
      if (audioInId.find("off_") != 0) {
        reject(@"SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH",
               [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@",
                                          audioBufferId],
               nil);
        return;
      }

      int inSampleRate = 0;
      int inNumSamples = 0;
      std::string errCode;
      std::string errMsg;
      if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
        reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioBufferId],
               nil);
        return;
      }
      if (inSampleRate <= 0 || inNumSamples <= 0) {
        reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
               nil);
        return;
      }

      std::vector<float> inputSamples;
      int inputSr = inSampleRate;
      bool useFull = !hasStarts;
      if (hasStarts) {
        id startObj = startSamples[i];
        id endObj = endSamples[i];
        const bool startNull = startObj == nil || startObj == [NSNull null];
        const bool endNull = endObj == nil || endObj == [NSNull null];
        if (startNull != endNull) {
          reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
                 [NSString stringWithFormat:
                     @"startSamples[%lu] and endSamples[%lu] must both be provided or both null",
                     (unsigned long)i, (unsigned long)i],
                 nil);
          return;
        }
        if (startNull) {
          useFull = true;
        } else {
          if (![startObj isKindOfClass:[NSNumber class]] ||
              ![endObj isKindOfClass:[NSNumber class]]) {
            reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
                   [NSString stringWithFormat:
                       @"startSamples[%lu] and endSamples[%lu] must be numbers or null",
                       (unsigned long)i, (unsigned long)i],
                   nil);
            return;
          }
          const int start =
              std::max(0, static_cast<int>(std::floor([(NSNumber *)startObj doubleValue])));
          const int endRaw =
              std::max(start, static_cast<int>(std::floor([(NSNumber *)endObj doubleValue])));
          const int end = std::min(endRaw, inNumSamples);
          const int frameCount = std::max(0, end - start);
          if (frameCount == 0) {
            continue;
          }
          std::string sliceErrCode;
          std::string sliceErrMsg;
          if (!pa_get_offline_samples_slice(
                  audioInId, start, frameCount, &inputSamples, &sliceErrCode, &sliceErrMsg)) {
            NSString *code = sliceErrCode.empty()
                ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
                : [NSString stringWithUTF8String:sliceErrCode.c_str()];
            NSString *msg = sliceErrMsg.empty()
                ? @"Failed to read offline audio slice"
                : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
            reject(code, msg, nil);
            return;
          }
        }
      }
      if (useFull) {
        if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) ||
            inputSamples.empty()) {
          continue;
        }
      }
      if (inputSamples.empty()) {
        continue;
      }

      std::vector<float> embedding =
          extractor->computeFromSamples(inputSamples, inputSr);
      if (embedding.empty()) {
        const std::string &computeError = extractor->lastError();
        const std::string &computeErrorCode = extractor->lastErrorCode();
        NSString *code = computeErrorCode.empty()
            ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
            : [NSString stringWithUTF8String:computeErrorCode.c_str()];
        NSString *msg = computeError.empty()
            ? @"Speaker embedding compute failed"
            : [NSString stringWithUTF8String:computeError.c_str()];
        reject(code, msg, nil);
        return;
      }
      embeddings.push_back(std::move(embedding));
    }

    if (embeddings.empty()) {
      resolve(@{ @"ok": @NO, @"embeddings": @[] });
      return;
    }

    const size_t dim = embeddings[0].size();
    std::vector<float> flat;
    flat.reserve(dim * embeddings.size());
    for (const auto &emb : embeddings) {
      if (emb.size() != dim) {
        reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
               @"Speaker embedding dimension mismatch during enroll", nil);
        return;
      }
      flat.insert(flat.end(), emb.begin(), emb.end());
    }

    const bool ok =
        manager->add(nameStr, flat, static_cast<int32_t>(embeddings.size()));
    resolve(@{
      @"ok": @(ok),
      @"embeddings": FloatVectorToNSArray(flat),
    });
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
           [NSString stringWithFormat:@"Speaker enroll offline failed: %@", exception.reason],
           nil);
  }
}

- (void)labelSpeakerIdentificationOfflineSegments:(NSString *)instanceId
                                        managerId:(NSString *)managerId
                                        audioInId:(NSString *)audioInId
                                     segmentsInId:(NSString *)segmentsInId
                                    segmentsOutId:(NSString *)segmentsOutId
                                        threshold:(double)threshold
                                          resolve:(RCTPromiseResolveBlock)resolve
                                           reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"instanceId is required", nil);
    return;
  }
  if (managerId == nil || [managerId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  if (audioInId == nil || [audioInId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR", @"audioInId is required", nil);
    return;
  }
  if (segmentsInId == nil || [segmentsInId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT", @"segmentsInId is required", nil);
    return;
  }
  if (segmentsOutId == nil || [segmentsOutId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT", @"segmentsOutId is required", nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string managerIdStr = [managerId UTF8String];
  const std::string audioInIdStr = [audioInId UTF8String];
  const std::string segmentsInIdStr = [segmentsInId UTF8String];
  const std::string segmentsOutIdStr = [segmentsOutId UTF8String];

  if (audioInIdStr.find("off_") != 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioInId],
           nil);
    return;
  }
  if (segmentsInIdStr.find("seg_off_") != 0) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*) for segmentsIn, got: %@", segmentsInId],
           nil);
    return;
  }
  if (segmentsOutIdStr.find("seg_off_") != 0) {
    reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*) for segmentsOut, got: %@", segmentsOutId],
           nil);
    return;
  }

  auto extractor =
      sherpaonnx::speaker_embedding::bridge::LookupExtractor(instanceIdStr);
  if (!extractor || !extractor->isInitialized()) {
    reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
           [NSString stringWithFormat:@"Speaker embedding extractor not found: %@", instanceId],
           nil);
    return;
  }
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInIdStr, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInId],
           nil);
    return;
  }

  std::vector<SegRecord> inputSegments;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto itIn = g_seg_offline.find(segmentsInIdStr);
    if (itIn == g_seg_offline.end() || !itIn->second) {
      reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentsInId],
             nil);
      return;
    }
    inputSegments = itIn->second->segments;

    auto itOut = g_seg_offline.find(segmentsOutIdStr);
    if (itOut == g_seg_offline.end() || !itOut->second) {
      reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentsOutId],
             nil);
      return;
    }
    if (!itOut->second->segments.empty()) {
      reject(@"SPEAKER_EMBEDDING_INVALID_ARGUMENT",
             [NSString stringWithFormat:@"segmentsOut must be an empty offline segment buffer: %@", segmentsOutId],
             nil);
      return;
    }
  }

  dispatch_async(SpeakerEmbeddingSerialQueue(), ^{
    @try {
      std::vector<SegRecord> speechSpans;
      speechSpans.reserve(inputSegments.size());
      for (const auto &seg : inputSegments) {
        if (seg.kind == "speech" && seg.endSample > seg.startSample) {
          speechSpans.push_back(seg);
        }
      }

      if (speechSpans.empty()) {
        {
          std::lock_guard<std::mutex> lock(g_seg_mutex);
          auto itOut = g_seg_offline.find(segmentsOutIdStr);
          if (itOut != g_seg_offline.end() && itOut->second) {
            itOut->second->segments.clear();
          }
        }
        resolve(@{
          @"labeledCount": @0,
          @"unknownCount": @0,
        });
        return;
      }

      std::vector<SegRecord> records;
      records.reserve(speechSpans.size());
      int labeledCount = 0;
      int unknownCount = 0;

      for (const auto &span : speechSpans) {
        const int start = std::max(0, span.startSample);
        const int end = std::min(span.endSample, inNumSamples);
        const int frameCount = std::max(0, end - start);

        std::vector<float> inputSamples;
        std::string sliceErrCode;
        std::string sliceErrMsg;
        if (frameCount > 0) {
          if (!pa_get_offline_samples_slice(
                  audioInIdStr, start, frameCount, &inputSamples, &sliceErrCode, &sliceErrMsg)) {
            NSString *code = sliceErrCode.empty()
                ? @"SPEAKER_EMBEDDING_COMPUTE_ERROR"
                : [NSString stringWithUTF8String:sliceErrCode.c_str()];
            NSString *msg = sliceErrMsg.empty()
                ? @"Failed to read offline audio slice"
                : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
            reject(code, msg, nil);
            return;
          }
        }

        std::string speakerName = "";
        if (!inputSamples.empty()) {
          std::vector<float> embedding =
              extractor->computeFromSamples(inputSamples, inSampleRate);
          if (!embedding.empty()) {
            std::string name = manager->search(embedding, static_cast<float>(threshold));
            if (!name.empty()) {
              speakerName = name;
              labeledCount++;
            } else {
              unknownCount++;
            }
          } else {
            unknownCount++;
          }
        } else {
          unknownCount++;
        }

        const int durationMs = span.durationMs > 0
            ? span.durationMs
            : ((inSampleRate > 0) ? ((span.endSample - span.startSample) * 1000) / inSampleRate : 0);

        SegRecord r = span;
        if (!speakerName.empty()) {
          NSString *nsSpeaker = [NSString stringWithUTF8String:speakerName.c_str()];
          NSString *escaped = [nsSpeaker stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
          r.payloadJson = std::string("{\"source\":\"sid\",\"speakerName\":\"") + [escaped UTF8String] + "\"}";
        } else {
          r.payloadJson = "{\"source\":\"sid\"}";
        }
        records.push_back(std::move(r));
      }

      {
        std::lock_guard<std::mutex> lock(g_seg_mutex);
        auto itOut = g_seg_offline.find(segmentsOutIdStr);
        if (itOut == g_seg_offline.end() || !itOut->second) {
          reject(@"SPEAKER_EMBEDDING_BUFFER_NOT_FOUND",
                 [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentsOutId],
                 nil);
          return;
        }
        itOut->second->segments = std::move(records);
      }

      resolve(@{
        @"labeledCount": @(labeledCount),
        @"unknownCount": @(unknownCount),
      });
    } @catch (NSException *exception) {
      reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
             [NSString stringWithFormat:@"Speaker identification labeling failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)unloadSpeakerEmbeddingExtractor:(NSString *)instanceId
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  std::shared_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
    auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors
                  .find(instanceIdStr);
    if (it !=
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors.end()) {
      doomed = std::move(it->second);
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors.erase(it);
    }
  }
  // Destructor releases when last shared_ptr drops (after in-flight compute).
  resolve(nil);
}

- (void)createSpeakerEmbeddingManager:(NSString *)managerId
                                  dim:(double)dim
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil || [managerId length] == 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  const int32_t dimInt = (int32_t)dim;
  if (dimInt <= 0) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"dim must be > 0", nil);
    return;
  }

  const std::string managerIdStr = [managerId UTF8String];
  @try {
    std::lock_guard<std::mutex> lock(
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
    // Replace the map entry so in-flight shared_ptrs keep the old wrapper.
    auto inst = std::make_shared<sherpaonnx::SpeakerEmbeddingManagerWrapper>();
    if (!inst->create(dimInt)) {
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.erase(
          managerIdStr);
      reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
             @"Failed to create speaker embedding manager", nil);
      return;
    }
    sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers[managerIdStr] =
        std::move(inst);
    resolve(@{ @"success": @YES });
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Manager create failed: %@", exception.reason],
           nil);
  }
}

- (void)speakerEmbeddingManagerAdd:(NSString *)managerId
                              name:(NSString *)name
                        embeddings:(NSArray *)embeddings
                             count:(double)count
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil || name == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId and name are required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  const int32_t countInt = (int32_t)count;
  auto flat = NSArrayToFloatVector(embeddings);

  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager || !manager->isInitialized()) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = manager->add(std::string([name UTF8String]), flat, countInt);
  resolve(@{ @"ok": @(ok) });
}

- (void)speakerEmbeddingManagerRemove:(NSString *)managerId
                                 name:(NSString *)name
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil || name == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId and name are required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = manager->remove(std::string([name UTF8String]));
  resolve(@{ @"ok": @(ok) });
}

- (void)speakerEmbeddingManagerSearch:(NSString *)managerId
                           embedding:(NSArray *)embedding
                           threshold:(double)threshold
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  auto emb = NSArrayToFloatVector(embedding);
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  std::string name =
      manager->search(emb, static_cast<float>(threshold));
  resolve(@{
    @"name": [NSString stringWithUTF8String:name.c_str()] ?: @""
  });
}

- (void)speakerEmbeddingManagerVerify:(NSString *)managerId
                                 name:(NSString *)name
                           embedding:(NSArray *)embedding
                           threshold:(double)threshold
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil || name == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId and name are required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  auto emb = NSArrayToFloatVector(embedding);
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = manager->verify(
      std::string([name UTF8String]), emb, static_cast<float>(threshold));
  resolve(@{ @"ok": @(ok) });
}

- (void)speakerEmbeddingManagerContains:(NSString *)managerId
                                   name:(NSString *)name
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil || name == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId and name are required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = manager->contains(std::string([name UTF8String]));
  resolve(@{ @"ok": @(ok) });
}

- (void)speakerEmbeddingManagerNumSpeakers:(NSString *)managerId
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  resolve(@(manager->numSpeakers()));
}

- (void)speakerEmbeddingManagerAllSpeakerNames:(NSString *)managerId
                                       resolve:(RCTPromiseResolveBlock)resolve
                                        reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR", @"managerId is required", nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  auto manager =
      sherpaonnx::speaker_embedding::bridge::LookupManager(managerIdStr);
  if (!manager) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  auto names = manager->allSpeakers();
  NSMutableArray *arr = [NSMutableArray arrayWithCapacity:names.size()];
  for (const auto &n : names) {
    [arr addObject:[NSString stringWithUTF8String:n.c_str()] ?: @""];
  }
  resolve(@{ @"names": arr });
}

- (void)destroySpeakerEmbeddingManager:(NSString *)managerId
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  if (managerId == nil || [managerId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string managerIdStr = [managerId UTF8String];
  std::shared_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
    auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                  .find(managerIdStr);
    if (it !=
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end()) {
      doomed = std::move(it->second);
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.erase(it);
    }
  }
  // Destructor releases when last shared_ptr drops (after in-flight manager ops).
  resolve(nil);
}

@end
