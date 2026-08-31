#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "sherpa-onnx-separation-wrapper.h"
#include "../core/SeparationBridgeState.h"
#include "../SeparationOfflineLivePipelineWorker.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "sherpa-onnx-model-path-fill.h"

#include <chrono>
#include <map>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <thread>
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

void StopActiveSeparationLivePipeline(const std::string &instanceIdStr) {
  std::string pipelineId;
  {
    std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
    auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
    if (it == sherpaonnx::separation::bridge::g_separation_instances.end()) {
      return;
    }
    pipelineId = it->second->activeLivePipelineId;
    it->second->activeLivePipelineId.clear();
  }
  if (pipelineId.empty()) {
    return;
  }

  std::shared_ptr<StreamingPipelineWorker> worker;
  {
    std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
    auto it = g_streaming_pipelines.find(pipelineId);
    if (it != g_streaming_pipelines.end()) {
      worker = it->second;
      g_streaming_pipelines.erase(it);
    }
  }
  if (!worker) {
    return;
  }

  so_mark_streaming_pipeline_stop_requested(pipelineId);
  worker->stop();

  using namespace std::chrono_literals;
  const auto deadline = std::chrono::steady_clock::now() + 120s;
  while (worker->isRunning() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(20ms);
  }
  worker->release();
}

struct SeparationInitScalars {
  int32_t numThreads = 1;
  bool debug = false;
  std::optional<std::string> provider;
};

SeparationInitScalars ParseSeparationInitScalars(
    const JS::NativeSherpaOnnx::SeparationInitBridgeOptions &options
) {
  SeparationInitScalars scalars;
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
                     options:(JS::NativeSherpaOnnx::SeparationInitBridgeOptions &)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *initMode = options.initMode();
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
      NSString *modelType = options.modelType();
      if (modelType == nil || [modelType length] == 0 || [modelType isEqualToString:@"auto"]) {
        reject(@"SEPARATION_INIT_ERROR", @"modelType is required for initMode custom", nil);
        return;
      }
      id pathsRaw = options.modelPaths();
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
      NSString *modelDir = options.modelDir();
      if (modelDir == nil || [modelDir length] == 0) {
        reject(@"SEPARATION_INIT_ERROR", @"modelDir is required for initMode auto", nil);
        return;
      }
      NSString *modelType = options.modelType();
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
      RCTLogWarn(@"[SherpaOnnxSeparation] initializeSeparation failed: %@", errorMsg);
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
    sherpaonnx::SeparationProcessResult processResult;
    try {
      if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
        reject(@"SEPARATION_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
               nil);
        return;
      }

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
    } catch (const std::bad_alloc &) {
      reject(kOfflineOomCode, kOfflineSeparationOomMessage, nil);
      return;
    }

    if (!processResult.success) {
      if (processResult.error.rfind("OFFLINE_OOM", 0) == 0) {
        reject(kOfflineOomCode, kOfflineSeparationOomMessage, nil);
        return;
      }
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

- (void)startSeparationOfflineLivePipeline:(NSString *)instanceId
                     audioInLiveBufferId:(NSString *)audioInLiveBufferId
                  audioOutLiveBufferIds:(NSArray<NSString *> *)audioOutLiveBufferIds
                                options:(JS::NativeSherpaOnnx::SpecStartSeparationOfflineLivePipelineOptions &)options
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  if (!instanceId || !audioInLiveBufferId || !audioOutLiveBufferIds) {
    reject(@"SEPARATION_ERROR", @"Missing required buffer IDs", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
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

  if (static_cast<NSInteger>(expectedStems) != (NSInteger)audioOutLiveBufferIds.count) {
    reject(@"SEPARATION_STEM_COUNT_MISMATCH",
           [NSString stringWithFormat:@"Expected %d output buffers, got %lu",
                                      expectedStems,
                                      (unsigned long)audioOutLiveBufferIds.count],
           nil);
    return;
  }

  std::string audioInId = [audioInLiveBufferId UTF8String];
  if (audioInId.find("live_") != 0) {
    reject(@"SEPARATION_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected live audio buffer (live_*) for audioIn, got: %@", audioInLiveBufferId],
           nil);
    return;
  }

  auto liveAudioIn = pa_get_live_entry(audioInId);
  if (!liveAudioIn) {
    reject(@"SEPARATION_BUFFER_NOT_FOUND", @"Input live buffer not found", nil);
    return;
  }

  std::vector<std::shared_ptr<PaLiveEntry>> liveAudioOuts;
  liveAudioOuts.reserve(audioOutLiveBufferIds.count);
  for (NSString *outId in audioOutLiveBufferIds) {
    if (outId == nil || [outId length] == 0) {
      reject(@"SEPARATION_BUFFER_NOT_FOUND", @"Output buffer id is empty", nil);
      return;
    }
    std::string outIdStr = [outId UTF8String];
    if (outIdStr.find("live_") != 0) {
      reject(@"SEPARATION_BUFFER_KIND_MISMATCH",
             [NSString stringWithFormat:@"Expected live audio buffer (live_*) for audioOut, got: %@", outId],
             nil);
      return;
    }
    auto liveAudioOut = pa_get_live_entry(outIdStr);
    if (!liveAudioOut) {
      reject(@"SEPARATION_BUFFER_NOT_FOUND", @"Output live buffer not found", nil);
      return;
    }
    liveAudioOuts.push_back(liveAudioOut);
  }

  NSString *attachedSegmentationEngineId = options.attachedSegmentationEngineId();
  NSString *segmentLiveBufferId = options.segmentLiveBufferId();

  if (!attachedSegmentationEngineId || !segmentLiveBufferId) {
    reject(@"LIVE_OFFLINE_SEGMENTATION_REQUIRED", @"Missing attachedSegmentationEngineId or segmentLiveBufferId", nil);
    return;
  }

  std::string attachedEngineIdStr = [attachedSegmentationEngineId UTF8String];
  std::string segmentBufferIdStr = [segmentLiveBufferId UTF8String];

  auto liveSegmentEntry = seg_get_live_entry(segmentBufferIdStr);
  if (!liveSegmentEntry) {
    reject(@"LIVE_OFFLINE_SEGMENTATION_REQUIRED", @"Segment buffer not found", nil);
    return;
  }

  NSString *uuidString = [[NSUUID UUID] UUIDString];
  std::string pipelineId = "live_offline_sep_" + std::string([uuidString UTF8String]);

  StopActiveSeparationLivePipeline(instanceIdStr);

  auto worker = std::make_shared<SeparationOfflineLivePipelineWorker>(
    pipelineId,
    attachedEngineIdStr,
    liveAudioIn,
    segmentBufferIdStr,
    liveAudioOuts,
    instanceIdStr
  );

  {
    std::lock_guard<std::mutex> lock(sherpaonnx::separation::bridge::g_separation_mutex);
    auto it = sherpaonnx::separation::bridge::g_separation_instances.find(instanceIdStr);
    if (it != sherpaonnx::separation::bridge::g_separation_instances.end()) {
      it->second->activeLivePipelineId = pipelineId;
    }
  }

  {
    std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
    g_streaming_pipelines[pipelineId] = worker;
  }
  worker->start();
  so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

  resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] });
}

- (void)unloadSeparation:(NSString *)instanceId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SEPARATION_ERROR", @"instanceId is required", nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  StopActiveSeparationLivePipeline(instanceIdStr);
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
