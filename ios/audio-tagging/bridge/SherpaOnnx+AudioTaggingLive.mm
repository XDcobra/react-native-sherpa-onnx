#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../core/AudioTaggingBridgeState.h"
#include "../pipeline/AudioTaggingOfflineLivePipelineWorker.h"

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace {

void StopActiveAudioTaggingLivePipeline(const std::string &instanceIdStr) {
  std::string pipelineId;
  {
    std::lock_guard<std::mutex> lock(sherpaonnx::audio_tagging::bridge::g_audio_tagging_mutex);
    auto it = sherpaonnx::audio_tagging::bridge::g_audio_tagging_instances.find(instanceIdStr);
    if (it == sherpaonnx::audio_tagging::bridge::g_audio_tagging_instances.end()) {
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

}  // namespace

@implementation SherpaOnnx (AudioTaggingLive)

- (void)startAudioTaggingOfflineLivePipeline:(NSString *)instanceId
                         audioInLiveBufferId:(NSString *)audioInLiveBufferId
                        textOutLiveBufferId:(NSString *)textOutLiveBufferId
                                    options:(JS::NativeSherpaOnnx::SpecStartAudioTaggingOfflineLivePipelineOptions &)options
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT", @"instanceId is required", nil);
    return;
  }
  if (audioInLiveBufferId == nil || [audioInLiveBufferId length] == 0) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT", @"audioInLiveBufferId is required", nil);
    return;
  }
  if (textOutLiveBufferId == nil || [textOutLiveBufferId length] == 0) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT", @"textOutLiveBufferId is required", nil);
    return;
  }

  NSString *attachedSegmentationEngineId = options.attachedSegmentationEngineId();
  if (attachedSegmentationEngineId == nil || [attachedSegmentationEngineId length] == 0) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT", @"options.attachedSegmentationEngineId is required", nil);
    return;
  }

  NSString *segmentLiveBufferId = options.segmentLiveBufferId();
  if (segmentLiveBufferId == nil || [segmentLiveBufferId length] == 0) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT", @"options.segmentLiveBufferId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string audioInIdStr = [audioInLiveBufferId UTF8String];
  std::string textOutIdStr = [textOutLiveBufferId UTF8String];
  std::string attachedEngineIdStr = [attachedSegmentationEngineId UTF8String];
  std::string segmentBufferIdStr = [segmentLiveBufferId UTF8String];

  auto taggingState = sherpaonnx::audio_tagging::bridge::LookupAudioTagging(instanceIdStr);
  if (!taggingState || taggingState->handle == nullptr) {
    reject(@"AUDIO_TAGGING_NOT_INITIALIZED",
           [NSString stringWithFormat:@"Audio tagging instance not found: %@", instanceId],
           nil);
    return;
  }

  auto inputEntry = pa_get_live_entry(audioInIdStr);
  if (!inputEntry) {
    reject(
      @"AUDIO_TAGGING_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Input live audio buffer not found: %@", audioInLiveBufferId],
      nil
    );
    return;
  }

  auto textOutEntry = txt_get_live_entry(textOutIdStr);
  if (!textOutEntry) {
    reject(
      @"AUDIO_TAGGING_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Output live text buffer not found: %@", textOutLiveBufferId],
      nil
    );
    return;
  }

  auto segmentInputEntry = seg_get_live_entry(segmentBufferIdStr);
  if (!segmentInputEntry) {
    reject(
      @"AUDIO_TAGGING_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Input live segment buffer not found: %@", segmentLiveBufferId],
      nil
    );
    return;
  }
  (void)segmentInputEntry;

  std::string targetSegmentsOutIdStr;
  NSString *targetOpt = options.targetSegmentLiveBufferId();
  if (targetOpt != nil && [targetOpt length] > 0) {
    targetSegmentsOutIdStr = [targetOpt UTF8String];
    auto targetEntry = seg_get_live_entry(targetSegmentsOutIdStr);
    if (!targetEntry) {
      reject(
        @"AUDIO_TAGGING_BUFFER_NOT_FOUND",
        [NSString stringWithFormat:@"Output live segment buffer not found: %@", targetOpt],
        nil
      );
      return;
    }
    (void)targetEntry;
  }

  int32_t effectiveTopK = taggingState->defaultTopK;
  auto topKOpt = options.topK();
  if (topKOpt.has_value()) {
    effectiveTopK = std::max<int32_t>(1, static_cast<int32_t>(topKOpt.value()));
  }

  try {
    StopActiveAudioTaggingLivePipeline(instanceIdStr);

    std::string pipelineId =
      std::string("at_live_") +
      std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    auto worker = std::make_shared<AudioTaggingOfflineLivePipelineWorker>(
      pipelineId,
      attachedEngineIdStr,
      inputEntry,
      segmentBufferIdStr,
      audioInIdStr,
      textOutEntry,
      targetSegmentsOutIdStr,
      taggingState,
      effectiveTopK
    );

    {
      std::lock_guard<std::mutex> lock(sherpaonnx::audio_tagging::bridge::g_audio_tagging_mutex);
      auto it = sherpaonnx::audio_tagging::bridge::g_audio_tagging_instances.find(instanceIdStr);
      if (it != sherpaonnx::audio_tagging::bridge::g_audio_tagging_instances.end()) {
        it->second->activeLivePipelineId = pipelineId;
      }
    }

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      g_streaming_pipelines[pipelineId] = worker;
    }

    worker->start();
    so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

    resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] ?: @"" });
  } catch (const std::exception &e) {
    reject(@"AUDIO_TAGGING_TAG_FAILED", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"AUDIO_TAGGING_TAG_FAILED", @"Failed to start audio tagging live pipeline", nil);
  }
}

@end
