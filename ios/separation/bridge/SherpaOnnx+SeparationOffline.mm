#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../sherpa-onnx-separation-wrapper.h"
#include "../core/SeparationBridgeState.h"
#include "sherpa-onnx-model-path-fill.h"

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

void FillSeparationModelPathsFromDict(
    NSDictionary *dict,
    sherpaonnx::SeparationModelPaths &paths
) {
  if (![dict isKindOfClass:[NSDictionary class]]) {
    return;
  }
  std::map<std::string, std::string> pathMap;
  for (NSString *key in dict) {
    id value = dict[key];
    if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
      pathMap[std::string([key UTF8String])] = std::string([(NSString *)value UTF8String]);
    }
  }
  sherpaonnx::FillSeparationModelPathsFromStringMap(pathMap, paths);
}

struct SeparationInitScalars {
  int32_t numThreads = 1;
  bool debug = false;
  std::optional<std::string> provider;
};

SeparationInitScalars ParseSeparationInitScalars(NSDictionary *options) {
  SeparationInitScalars scalars;
  if ([options[@"numThreads"] respondsToSelector:@selector(intValue)]) {
    scalars.numThreads = MAX(1, [options[@"numThreads"] intValue]);
  }
  if ([options[@"debug"] respondsToSelector:@selector(boolValue)]) {
    scalars.debug = [options[@"debug"] boolValue];
  }
  scalars.provider = OptionalUtf8String(options[@"provider"]);
  return scalars;
}

std::string ModelTypeOrAuto(NSString *modelType) {
  if (modelType == nil || [modelType length] == 0) {
    return "auto";
  }
  return std::string([modelType UTF8String]);
}

}  // namespace

@implementation SherpaOnnx (Separation)

static NSString *const kOfflineOomCode = @"OFFLINE_OOM";
static NSString *const kOfflineSeparationOomMessage =
    @"Not enough memory for offline source separation. Please use a streaming mode for large inputs. "
    @"Alternatively, use the segmentation engine to process smaller segments with offline models "
    @"(see docs/segmentation-engine.md).";

- (void)initializeSeparation:(NSString *)instanceId
                     options:(NSDictionary *)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *initMode = options[@"initMode"];
  if (initMode == nil || [initMode length] == 0) {
    initMode = @"auto";
  }
  const bool isCustomInit = [initMode isEqualToString:@"custom"];
  const std::string instanceIdStr = [instanceId UTF8String];
  const SeparationInitScalars scalars = ParseSeparationInitScalars(options);

  @try {
    std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
    auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
    if (it == sherpaonnx::separation::bridge::g_separation_instances.end()) {
      sherpaonnx::separation::bridge::g_separation_instances[instanceIdStr] =
          std::make_unique<sherpaonnx::separation::bridge::SeparationInstanceState>();
    }

    auto *inst = sherpaonnx::separation::bridge::g_separation_instances[instanceIdStr].get();
    if (inst->wrapper == nullptr) {
      inst->wrapper = std::make_unique<sherpaonnx::SeparationWrapper>();
    }

    sherpaonnx::SeparationInitializeResult result;
    if (isCustomInit) {
      NSString *modelType = options[@"modelType"];
      if (modelType == nil || [modelType length] == 0 || [modelType isEqualToString:@"auto"]) {
        reject(@"SEPARATION_INIT_ERROR", @"modelType is required for initMode custom", nil);
        return;
      }
      id pathsRaw = options[@"modelPaths"];
      NSDictionary *pathsDict =
          [pathsRaw isKindOfClass:[NSDictionary class]] ? (NSDictionary *)pathsRaw : nil;
      if (pathsDict == nil || pathsDict.count == 0) {
        reject(@"SEPARATION_INIT_ERROR", @"modelPaths is required for initMode custom", nil);
        return;
      }

      sherpaonnx::SeparationModelPaths paths;
      FillSeparationModelPathsFromDict(pathsDict, paths);
      result = inst->wrapper->initializeCustom(
          std::string([modelType UTF8String]),
          paths,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    } else {
      NSString *modelDir = options[@"modelDir"];
      if (modelDir == nil || [modelDir length] == 0) {
        reject(@"SEPARATION_INIT_ERROR", @"modelDir is required for initMode auto", nil);
        return;
      }
      NSString *modelType = options[@"modelType"];
      result = inst->wrapper->initialize(
          std::string([modelDir UTF8String]),
          ModelTypeOrAuto(modelType),
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    }

    if (!result.success) {
      sherpaonnx::separation::bridge::g_separation_instances.erase(instanceIdStr);
      NSString *errorMsg = result.error.empty()
          ? @"Failed to initialize separation"
          : [NSString stringWithUTF8String:result.error.c_str()];
      reject(@"SEPARATION_INIT_ERROR", errorMsg, nil);
      return;
    }

    NSMutableArray *detectedModelsArray = [NSMutableArray array];
    for (const auto &model : result.detectedModels) {
      [detectedModelsArray addObject:@{
        @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
        @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
      }];
    }

    resolve(@{
      @"success": @YES,
      @"detectedModels": detectedModelsArray,
      @"modelType": [NSString stringWithUTF8String:result.modelType.c_str()] ?: @"unknown",
      @"sampleRate": @(result.sampleRate),
      @"numStems": @(result.numStems),
    });
  } @catch (NSException *exception) {
    reject(@"SEPARATION_INIT_ERROR",
           [NSString stringWithFormat:@"Separation init failed: %@", exception.reason],
           nil);
  }
}

- (void)separateOfflineAudioBuffers:(NSString *)instanceId
                    audioInBufferId:(NSString *)audioInBufferId
                 audioOutBufferIds:(NSArray<NSString *> *)audioOutBufferIds
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_ERROR", @"instanceId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(@"SEPARATION_BUFFER_NOT_FOUND", @"audioInBufferId is required", nil);
    return;
  }
  if (audioOutBufferIds == nil || audioOutBufferIds.count == 0) {
    reject(@"SEPARATION_BUFFER_NOT_FOUND", @"audioOutBufferIds is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string audioInId = [audioInBufferId UTF8String];

  if (audioInId.find("off_") != 0) {
    reject(@"SEPARATION_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioIn, got: %@", audioInBufferId],
           nil);
    return;
  }

  int expectedStems = 0;
  {
    std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
    auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
    if (it == sherpaonnx::separation::bridge::g_separation_instances.end() ||
        it->second->wrapper == nullptr) {
      reject(@"SEPARATION_ERROR", @"Separation instance not found", nil);
      return;
    }
    expectedStems = it->second->wrapper->getNumStems();
  }

  if (static_cast<NSInteger>(expectedStems) != (NSInteger)audioOutBufferIds.count) {
    reject(@"SEPARATION_STEM_COUNT_MISMATCH",
           [NSString stringWithFormat:@"Expected %d output buffers, got %lu",
                                      expectedStems,
                                      (unsigned long)audioOutBufferIds.count],
           nil);
    return;
  }

  std::vector<std::string> audioOutIds;
  audioOutIds.reserve(audioOutBufferIds.count);
  for (NSString *outId in audioOutBufferIds) {
    if (outId == nil || [outId length] == 0) {
      reject(@"SEPARATION_BUFFER_NOT_FOUND", @"Output buffer id is empty", nil);
      return;
    }
    std::string outIdStr = [outId UTF8String];
    if (outIdStr.find("off_") != 0) {
      reject(@"SEPARATION_BUFFER_KIND_MISMATCH",
             [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioOut, got: %@", outId],
             nil);
      return;
    }
    int outNumSamples = 0;
    int outSampleRate = 0;
    std::string errCode;
    std::string errMsg;
    if (!pa_get_offline_metadata(outIdStr, &outSampleRate, &outNumSamples, &errCode, &errMsg)) {
      reject(@"SEPARATION_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Offline audio buffer not found: %@", outId],
             nil);
      return;
    }
    if (outNumSamples != 0) {
      reject(@"SEPARATION_OUTPUT_NOT_EMPTY",
             [NSString stringWithFormat:@"Output offline audio buffer must be empty: %@", outId],
             nil);
      return;
    }
    audioOutIds.push_back(outIdStr);
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"SEPARATION_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"SEPARATION_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
           nil);
    return;
  }

  @try {
    std::vector<float> inputSamples;
    int inputSr = 0;
    if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
      reject(@"SEPARATION_BUFFER_EMPTY",
             [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
             nil);
      return;
    }

    sherpaonnx::SeparationProcessResult processResult;
    {
      std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
      auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
      if (it == sherpaonnx::separation::bridge::g_separation_instances.end() ||
          it->second->wrapper == nullptr) {
        reject(@"SEPARATION_ERROR", @"Separation instance not found", nil);
        return;
      }
      processResult = it->second->wrapper->processMonoSamples(inputSamples, inputSr);
    }

    if (!processResult.success) {
      NSString *errorMsg = processResult.error.empty()
          ? @"Failed to separate audio"
          : [NSString stringWithUTF8String:processResult.error.c_str()];
      reject(@"SEPARATION_ERROR", errorMsg, nil);
      return;
    }

    if (processResult.stems.size() != audioOutIds.size()) {
      reject(@"SEPARATION_ERROR", @"Native separation stem count mismatch", nil);
      return;
    }

    for (size_t i = 0; i < processResult.stems.size(); ++i) {
      const std::string &outId = audioOutIds[i];
      std::vector<float> stemSamples = std::move(processResult.stems[i].samples);
      std::string adoptErrCode;
      std::string adoptErrMsg;
      if (!pa_adopt_offline_samples_if_empty(outId, std::move(stemSamples), &adoptErrCode, &adoptErrMsg)) {
        reject(@"SEPARATION_OUTPUT_NOT_EMPTY",
               [NSString stringWithFormat:@"Output buffer was populated concurrently: %@",
                                          [NSString stringWithUTF8String:outId.c_str()]],
               nil);
        return;
      }
      pa_upgradeToMmapIfNeeded(outId);
    }

    resolve(nil);
  } @catch (NSException *exception) {
    NSString *reason = exception.reason ?: @"";
    NSString *reasonLower = [reason lowercaseString];
    if ([reasonLower containsString:@"memory"] || [reasonLower containsString:@"alloc"]) {
      reject(kOfflineOomCode, kOfflineSeparationOomMessage, nil);
      return;
    }
    reject(@"SEPARATION_ERROR",
           [NSString stringWithFormat:@"Separation failed: %@", reason],
           nil);
  }
}

- (void)getSeparationSampleRate:(NSString *)instanceId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_ERROR", @"instanceId is required", nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
  auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
  if (it == sherpaonnx::separation::bridge::g_separation_instances.end() ||
      it->second->wrapper == nullptr) {
    reject(@"SEPARATION_ERROR", @"Separation instance not found", nil);
    return;
  }
  resolve(@(it->second->wrapper->getSampleRate()));
}

- (void)getSeparationNumStems:(NSString *)instanceId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_ERROR", @"instanceId is required", nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
  auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
  if (it == sherpaonnx::separation::bridge::g_separation_instances.end() ||
      it->second->wrapper == nullptr) {
    reject(@"SEPARATION_ERROR", @"Separation instance not found", nil);
    return;
  }
  resolve(@(it->second->wrapper->getNumStems()));
}

- (void)unloadSeparation:(NSString *)instanceId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_ERROR", @"instanceId is required", nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
  auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
  if (it != sherpaonnx::separation::bridge::g_separation_instances.end()) {
    if (it->second->wrapper != nullptr) {
      it->second->wrapper->release();
    }
    sherpaonnx::separation::bridge::g_separation_instances.erase(it);
  }
  resolve(nil);
}

@end
