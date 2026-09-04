#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../core/SpeakerEmbeddingBridgeState.h"
#include "../core/SpeakerEmbeddingBridgeUtils.h"
#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include "sherpa-onnx-model-path-fill.h"

#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

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
    std::lock_guard<std::mutex> lock(
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
    auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors
                  .find(instanceIdStr);
    if (it ==
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors.end()) {
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors[instanceIdStr] =
          std::make_unique<
              sherpaonnx::speaker_embedding::bridge::SpeakerEmbeddingExtractorState>();
    }

    auto *inst =
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors[instanceIdStr]
            .get();
    if (inst->wrapper == nullptr) {
      inst->wrapper =
          std::make_unique<sherpaonnx::SpeakerEmbeddingExtractorWrapper>();
    }

    sherpaonnx::SpeakerEmbeddingInitializeResult result;
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
      sherpaonnx::SpeakerEmbeddingModelPaths paths;
      FillSpeakerEmbeddingModelPathsFromDict((NSDictionary *)modelPathsObj, paths);
      result = inst->wrapper->initializeCustom(
          std::string([modelType UTF8String]),
          paths,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    } else {
      NSString *modelDir = options.modelDir();
      if (modelDir == nil || [modelDir length] == 0) {
        reject(@"SPEAKER_EMBEDDING_INIT_ERROR",
               @"modelDir is required for initMode auto", nil);
        return;
      }
      NSString *modelType = options.modelType();
      std::string modelTypeStr =
          sherpaonnx::speaker_embedding::bridge::ModelTypeOrAuto(modelType);
      result = inst->wrapper->initialize(
          std::string([modelDir UTF8String]),
          modelTypeStr,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    }

    if (!result.success) {
      NSString *errorMsg = result.error.empty()
          ? @"Failed to initialize speaker embedding extractor"
          : [NSString stringWithUTF8String:result.error.c_str()];
      reject(@"SPEAKER_EMBEDDING_INIT_ERROR", errorMsg, nil);
      return;
    }

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
    int inputSr = 0;
    if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
      reject(@"SPEAKER_EMBEDDING_BUFFER_EMPTY",
             [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
             nil);
      return;
    }

    std::vector<float> embedding;
    std::string computeError;
    std::string computeErrorCode;
    {
      std::lock_guard<std::mutex> lock(
          sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
      auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors
                    .find(instanceIdStr);
      if (it ==
              sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors
                  .end() ||
          it->second == nullptr || it->second->wrapper == nullptr ||
          !it->second->wrapper->isInitialized()) {
        reject(@"SPEAKER_EMBEDDING_COMPUTE_ERROR",
               [NSString stringWithFormat:@"Speaker embedding extractor not found: %@", instanceId],
               nil);
        return;
      }
      embedding = it->second->wrapper->computeFromSamples(inputSamples, inputSr);
      if (embedding.empty()) {
        computeError = it->second->wrapper->lastError();
        computeErrorCode = it->second->wrapper->lastErrorCode();
      }
    }
    if (embedding.empty()) {
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

- (void)unloadSpeakerEmbeddingExtractor:(NSString *)instanceId
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors
                .find(instanceIdStr);
  if (it !=
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors.end()) {
    if (it->second != nullptr && it->second->wrapper != nullptr) {
      it->second->wrapper->release();
    }
    sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_extractors.erase(it);
  }
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
    auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                  .find(managerIdStr);
    if (it ==
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end()) {
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers[managerIdStr] =
          std::make_unique<
              sherpaonnx::speaker_embedding::bridge::SpeakerEmbeddingManagerState>();
    }
    auto *inst =
        sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers[managerIdStr]
            .get();
    if (inst->wrapper == nullptr) {
      inst->wrapper = std::make_unique<sherpaonnx::SpeakerEmbeddingManagerWrapper>();
    } else {
      inst->wrapper->release();
    }
    if (!inst->wrapper->create(dimInt)) {
      reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
             @"Failed to create speaker embedding manager", nil);
      return;
    }
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

  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr ||
      !it->second->wrapper->isInitialized()) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = it->second->wrapper->add(
      std::string([name UTF8String]), flat, countInt);
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = it->second->wrapper->remove(std::string([name UTF8String]));
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  std::string name =
      it->second->wrapper->search(emb, static_cast<float>(threshold));
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = it->second->wrapper->verify(
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  bool ok = it->second->wrapper->contains(std::string([name UTF8String]));
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  resolve(@(it->second->wrapper->numSpeakers()));
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it == sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end() ||
      it->second == nullptr || it->second->wrapper == nullptr) {
    reject(@"SPEAKER_EMBEDDING_MANAGER_ERROR",
           [NSString stringWithFormat:@"Speaker embedding manager not found: %@", managerId],
           nil);
    return;
  }
  auto names = it->second->wrapper->allSpeakers();
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
  std::lock_guard<std::mutex> lock(
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_mutex);
  auto it = sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers
                .find(managerIdStr);
  if (it !=
      sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.end()) {
    if (it->second != nullptr && it->second->wrapper != nullptr) {
      it->second->wrapper->release();
    }
    sherpaonnx::speaker_embedding::bridge::g_speaker_embedding_managers.erase(it);
  }
  resolve(nil);
}

@end
