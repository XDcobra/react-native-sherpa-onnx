#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../sherpa-onnx-enhancement-wrapper.h"
#include "../core/EnhancementBridgeState.h"
#include "../EnhancementOfflineLivePipelineWorker.h"
#include "../../segment/core/SherpaOnnx+SegmentationGlobals.h"
#include "../../segment/engine/SegmentationEngineRegistry.h"
#include "../../segment/pipeline/SegmentPipelineRegistry.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"

#include <memory>
#include <mutex>
#include <string>
#include <vector>

@implementation SherpaOnnx (Enhancement)

static NSString *const kOfflineOomCode = @"OFFLINE_OOM";
static NSString *const kOfflineEnhancementOomMessage =
    @"Not enough memory for offline enhancement. Please use a streaming mode for large inputs. "
    @"Alternatively, use the segmentation engine to process smaller segments with offline models "
    @"(see docs/segmentation-engine.md).";

- (void)enhanceOfflineAudioBuffers:(NSString *)instanceId
                   audioInBufferId:(NSString *)audioInBufferId
                  audioOutBufferId:(NSString *)audioOutBufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  RCTLogInfo(
    @"[Enhancement] enhanceOfflineAudioBuffers called instanceId=%@ audioInBufferId=%@ audioOutBufferId=%@",
    instanceId,
    audioInBufferId,
    audioOutBufferId
  );
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ENHANCEMENT_ERROR", @"instanceId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND", @"audioInBufferId is required", nil);
    return;
  }
  if (audioOutBufferId == nil || [audioOutBufferId length] == 0) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND", @"audioOutBufferId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string audioInId = [audioInBufferId UTF8String];
  std::string audioOutId = [audioOutBufferId UTF8String];

  if (audioInId.find("off_") != 0) {
    reject(@"ENHANCEMENT_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioIn, got: %@", audioInBufferId],
           nil);
    return;
  }

  if (audioOutId.find("off_") != 0) {
    reject(@"ENHANCEMENT_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioOut, got: %@", audioOutBufferId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
           nil);
    return;
  }

  int outSampleRate = 0;
  int outNumSamples = 0;
  if (!pa_get_offline_metadata(audioOutId, &outSampleRate, &outNumSamples, &errCode, &errMsg)) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioOutBufferId],
           nil);
    return;
  }

  if (inSampleRate <= 0 || inNumSamples <= 0) {
    RCTLogInfo(
      @"[Enhancement] input buffer invalid: bufferId=%@ sampleRate=%d numSamples=%d",
      audioInBufferId,
      inSampleRate,
      inNumSamples
    );
    reject(@"ENHANCEMENT_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
           nil);
    return;
  }

  if (outNumSamples != 0) {
    RCTLogInfo(
      @"[Enhancement] output buffer not empty: bufferId=%@ outNumSamples=%d outSampleRate=%d",
      audioOutBufferId,
      outNumSamples,
      outSampleRate
    );
    reject(@"ENHANCEMENT_OUTPUT_NOT_EMPTY",
           [NSString stringWithFormat:@"Output offline audio buffer must be empty: %@", audioOutBufferId],
           nil);
    return;
  }

  @try {
    std::vector<float> inputSamples;
    int inputSr = 0;
    if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
      RCTLogInfo(
        @"[Enhancement] read offline samples failed or empty: bufferId=%@ inputSr=%d inputSamplesSize=%zu",
        audioInBufferId,
        inputSr,
        inputSamples.size()
      );
      reject(@"ENHANCEMENT_BUFFER_EMPTY",
             [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
             nil);
      return;
    }

    RCTLogInfo(
      @"[Enhancement] input samples materialized: bufferId=%@ inputSr=%d inputSamplesSize=%zu (metaSr=%d metaNumSamples=%d) outBufferId=%@",
      audioInBufferId,
      inputSr,
      inputSamples.size(),
      inSampleRate,
      inNumSamples,
      audioOutBufferId
    );

    sherpaonnx::EnhancedAudioResult enhancedResult;
    {
      std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
      auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
      if (it == sherpaonnx::enhancement::bridge::g_enhancement_instances.end() || it->second->wrapper == nullptr) {
        reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
        return;
      }
      enhancedResult = it->second->wrapper->runSamples(inputSamples, inputSr);
    }

    {
      std::string adoptErrCode;
      std::string adoptErrMsg;
      if (!pa_adopt_offline_samples_if_empty(audioOutId, std::move(enhancedResult.samples), &adoptErrCode, &adoptErrMsg)) {
        reject(@"ENHANCEMENT_OUTPUT_NOT_EMPTY",
               [NSString stringWithFormat:@"Output buffer was populated concurrently: %@", audioOutBufferId],
               nil);
        return;
      }
    }

    // Upgrade output to mmap if it exceeds the threshold
    pa_upgradeToMmapIfNeeded(audioOutId);

    resolve(nil);
  } @catch (NSException *exception) {
    NSString *reason = exception.reason ?: @"";
    NSString *reasonLower = [reason lowercaseString];
    if ([reasonLower containsString:@"memory"] || [reasonLower containsString:@"alloc"]) {
      reject(kOfflineOomCode, kOfflineEnhancementOomMessage, nil);
      return;
    }
    reject(@"ENHANCEMENT_ERROR",
           [NSString stringWithFormat:@"Enhancement failed: %@", reason],
           nil);
  }
}

- (void)getEnhancementSampleRate:(NSString *)instanceId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ENHANCEMENT_ERROR", @"instanceId is required", nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];

  std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
  auto offlineIt = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
  if (offlineIt != sherpaonnx::enhancement::bridge::g_enhancement_instances.end() &&
      offlineIt->second->wrapper != nullptr) {
    resolve(@(offlineIt->second->wrapper->getSampleRate()));
    return;
  }

  auto onlineIt = sherpaonnx::enhancement::bridge::g_online_enhancement_instances.find(instanceIdStr);
  if (onlineIt != sherpaonnx::enhancement::bridge::g_online_enhancement_instances.end() &&
      onlineIt->second->wrapper != nullptr) {
    resolve(@(onlineIt->second->wrapper->getSampleRate()));
    return;
  }

  reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
  return;
}

- (void)unloadEnhancement:(NSString *)instanceId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
  auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
  if (it != sherpaonnx::enhancement::bridge::g_enhancement_instances.end() && it->second->wrapper != nullptr) {
    it->second->wrapper->release();
    sherpaonnx::enhancement::bridge::g_enhancement_instances.erase(it);
  }
  resolve(nil);
}

- (void)startEnhancementOfflineLivePipeline:(NSString *)instanceId
                        audioInLiveBufferId:(NSString *)audioInLiveBufferId
                       audioOutLiveBufferId:(NSString *)audioOutLiveBufferId
                                    options:(NSDictionary *)options
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  if (!instanceId || !audioInLiveBufferId || !audioOutLiveBufferId) {
    reject(@"ENHANCEMENT_ERROR", @"Missing required buffer IDs", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  sherpaonnx::EnhancementWrapper *enhancer = nullptr;
  {
    std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
    auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
    if (it == sherpaonnx::enhancement::bridge::g_enhancement_instances.end() || it->second->wrapper == nullptr) {
      reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
      return;
    }
    enhancer = it->second->wrapper.get();
  }

  std::string audioInId = [audioInLiveBufferId UTF8String];
  std::string audioOutId = [audioOutLiveBufferId UTF8String];

  auto liveAudioIn = pa_get_live_entry(audioInId);
  if (!liveAudioIn) {
    reject(@"ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND", @"Input live buffer not found", nil);
    return;
  }
  auto liveAudioOut = pa_get_live_entry(audioOutId);
  if (!liveAudioOut) {
    reject(@"ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND", @"Output live buffer not found", nil);
    return;
  }

  NSDictionary *policyMap = options[@"segmentationPolicy"];
  if (!policyMap) {
    reject(@"LIVE_OFFLINE_SEGMENTATION_REQUIRED", @"segmentationPolicy missing on native bridge", nil);
    return;
  }
  
  NSString *evaluator = policyMap[@"evaluator"];
  if (![evaluator isEqualToString:@"continuous_frames"]) {
    reject(@"LIVE_OFFLINE_SEGMENTATION_REQUIRED",
           [NSString stringWithFormat:@"live enhancement supports only continuous_frames policy; received %@", evaluator],
           nil);
    return;
  }

  std::string errCode, errMsg;
  auto parsedPolicy = sherpaonnx::segmentation::parseSegmentationPolicy(policyMap, &errCode, &errMsg);
  if (!errCode.empty()) {
    reject([NSString stringWithUTF8String:errCode.c_str()], [NSString stringWithUTF8String:errMsg.c_str()], nil);
    return;
  }

  auto seg = sherpaonnx::segmentation::SegmentationEngineRegistry::getInstance().attach(
    audioInId, "speech", parsedPolicy, &errCode, &errMsg
  );
  if (!seg) {
    reject([NSString stringWithUTF8String:errCode.c_str()], [NSString stringWithUTF8String:errMsg.c_str()], nil);
    return;
  }

  auto liveSegmentEntry = sherpaonnx::segmentation::SegmentPipelineRegistry::getInstance().getLiveEntry(seg->segmentBufferId);
  if (!liveSegmentEntry) {
    reject(@"LIVE_OFFLINE_SEGMENTATION_REQUIRED", @"Segment buffer not found", nil);
    return;
  }

  NSString *uuidString = [[NSUUID UUID] UUIDString];
  std::string pipelineId = "live_offline_enh_" + std::string([uuidString UTF8String]);

  auto worker = std::make_shared<EnhancementOfflineLivePipelineWorker>(
    pipelineId,
    seg->engineId,
    liveAudioIn,
    seg->segmentBufferId,
    liveAudioOut,
    enhancer
  );

  {
    std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
    g_streaming_pipelines[pipelineId] = worker;
  }
  worker->start();
  so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

  resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] });
}

@end