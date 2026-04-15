#import "../../SherpaOnnx.h"

#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../EnhancementPipelineWorker.h"
#include "../sherpa-onnx-enhancement-wrapper.h"
#include "../core/EnhancementBridgeState.h"

#include <memory>
#include <mutex>
#include <string>

@implementation SherpaOnnx (Enhancement)

- (void)unloadOnlineEnhancement:(NSString *)instanceId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
  auto it = sherpaonnx::enhancement::bridge::g_online_enhancement_instances.find(instanceIdStr);
  if (it != sherpaonnx::enhancement::bridge::g_online_enhancement_instances.end() && it->second->wrapper != nullptr) {
    if (it->second->wrapper.use_count() > 1) {
      reject(@"ONLINE_ENHANCEMENT_ERROR",
             @"Online enhancement instance is currently used by an active streaming pipeline",
             nil);
      return;
    }
    it->second->wrapper->release();
    sherpaonnx::enhancement::bridge::g_online_enhancement_instances.erase(it);
  }
  resolve(nil);
}

- (void)startEnhancementPipeline:(NSString *)instanceId
                   inputBufferId:(NSString *)inputBufferId
                  outputBufferId:(NSString *)outputBufferId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ONLINE_ENHANCEMENT_ERROR", @"instanceId is required", nil);
    return;
  }
  if (inputBufferId == nil || [inputBufferId length] == 0 ||
      outputBufferId == nil || [outputBufferId length] == 0) {
    reject(@"AUDIO_BUFFER_NOT_FOUND", @"inputBufferId and outputBufferId are required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string inputIdStr = [inputBufferId UTF8String];
  std::string outputIdStr = [outputBufferId UTF8String];

  std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> wrapper;
  {
    std::lock_guard<std::mutex> enhLock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
    auto enhIt = sherpaonnx::enhancement::bridge::g_online_enhancement_instances.find(instanceIdStr);
    if (enhIt == sherpaonnx::enhancement::bridge::g_online_enhancement_instances.end() || !enhIt->second->wrapper) {
      reject(@"ONLINE_ENHANCEMENT_ERROR", @"Online enhancement instance not found", nil);
      return;
    }
    wrapper = enhIt->second->wrapper;
  }

  std::shared_ptr<PaLiveEntry> inputEntry;
  std::shared_ptr<PaLiveEntry> outputEntry;
  {
    std::lock_guard<std::mutex> paLock(g_pa_mutex);

    auto inIt = g_pa_live.find(inputIdStr);
    if (inIt == g_pa_live.end()) {
      reject(@"AUDIO_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Input live buffer '%@' not found", inputBufferId],
             nil);
      return;
    }
    inputEntry = inIt->second;

    auto outIt = g_pa_live.find(outputIdStr);
    if (outIt == g_pa_live.end()) {
      reject(@"AUDIO_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Output live buffer '%@' not found", outputBufferId],
             nil);
      return;
    }
    outputEntry = outIt->second;
  }

  if (inputEntry->state != PaLiveEntry::RECORDING) {
    reject(@"ONLINE_ENHANCEMENT_ERROR", @"Input buffer is already finalized", nil);
    return;
  }

  int modelSr = wrapper->getSampleRate();
  if (inputEntry->sampleRate != modelSr) {
    reject(@"ONLINE_ENHANCEMENT_ERROR",
           [NSString stringWithFormat:@"Input buffer sample rate (%d) does not match model sample rate (%d)",
                                      inputEntry->sampleRate,
                                      modelSr],
           nil);
    return;
  }

  auto worker = std::make_shared<EnhancementPipelineWorker>(wrapper, inputEntry, outputEntry);
  std::string pid = worker->pipelineId;

  {
    std::lock_guard<std::mutex> pipeLock(g_streaming_pipeline_mutex);
    g_streaming_pipelines[pid] = worker;
  }

  worker->start();

  resolve(@{
    @"pipelineId": [NSString stringWithUTF8String:pid.c_str()],
  });
}

@end