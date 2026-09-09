#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../core/LanguageIdBridgeState.h"
#include "../pipeline/SlidOfflineLivePipelineWorker.h"

#include <chrono>
#include <memory>
#include <mutex>
#include <string>

@implementation SherpaOnnx (LanguageIdLive)

- (void)startLanguageIdOfflineLivePipeline:(NSString *)instanceId
                       audioInLiveBufferId:(NSString *)audioInLiveBufferId
                      textOutLiveBufferId:(NSString *)textOutLiveBufferId
                                  options:(JS::NativeSherpaOnnx::SpecStartLanguageIdOfflineLivePipelineOptions &)options
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT", @"instanceId is required", nil);
    return;
  }
  if (audioInLiveBufferId == nil || [audioInLiveBufferId length] == 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT", @"audioInLiveBufferId is required", nil);
    return;
  }
  if (textOutLiveBufferId == nil || [textOutLiveBufferId length] == 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT", @"textOutLiveBufferId is required", nil);
    return;
  }

  NSString *attachedSegmentationEngineId = options.attachedSegmentationEngineId();
  if (attachedSegmentationEngineId == nil || [attachedSegmentationEngineId length] == 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT", @"options.attachedSegmentationEngineId is required", nil);
    return;
  }

  NSString *segmentLiveBufferId = options.segmentLiveBufferId();
  if (segmentLiveBufferId == nil || [segmentLiveBufferId length] == 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT", @"options.segmentLiveBufferId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string audioInIdStr = [audioInLiveBufferId UTF8String];
  std::string textOutIdStr = [textOutLiveBufferId UTF8String];
  std::string attachedEngineIdStr = [attachedSegmentationEngineId UTF8String];
  std::string segmentBufferIdStr = [segmentLiveBufferId UTF8String];

  auto slidState = sherpaonnx::language_id::bridge::LookupLanguageId(instanceIdStr);
  if (!slidState || slidState->handle == nullptr) {
    reject(@"LANGUAGE_ID_NOT_INITIALIZED",
           [NSString stringWithFormat:@"SLID instance not found: %@", instanceId],
           nil);
    return;
  }

  auto inputEntry = pa_get_live_entry(audioInIdStr);
  if (!inputEntry) {
    reject(
      @"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Input live audio buffer not found: %@", audioInLiveBufferId],
      nil
    );
    return;
  }

  auto textOutEntry = txt_get_live_entry(textOutIdStr);
  if (!textOutEntry) {
    reject(
      @"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Output live text buffer not found: %@", textOutLiveBufferId],
      nil
    );
    return;
  }

  auto segmentInputEntry = seg_get_live_entry(segmentBufferIdStr);
  if (!segmentInputEntry) {
    reject(
      @"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Input live segment buffer not found: %@", segmentLiveBufferId],
      nil
    );
    return;
  }
  (void)segmentInputEntry;

  std::string targetSegmentsOutIdStr;
  auto targetOpt = options.targetSegmentLiveBufferId();
  if (targetOpt.has_value() && targetOpt.value() != nil && [targetOpt.value() length] > 0) {
    targetSegmentsOutIdStr = [targetOpt.value() UTF8String];
    auto targetEntry = seg_get_live_entry(targetSegmentsOutIdStr);
    if (!targetEntry) {
      reject(
        @"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
        [NSString stringWithFormat:@"Output live segment buffer not found: %@", targetOpt.value()],
        nil
      );
      return;
    }
    (void)targetEntry;
  }

  try {
    std::string pipelineId =
      std::string("slid_live_") +
      std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    auto worker = std::make_shared<SlidOfflineLivePipelineWorker>(
      pipelineId,
      attachedEngineIdStr,
      inputEntry,
      segmentBufferIdStr,
      audioInIdStr,
      textOutEntry,
      targetSegmentsOutIdStr,
      std::move(slidState)
    );

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      g_streaming_pipelines[pipelineId] = worker;
    }

    worker->start();
    so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

    resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] ?: @"" });
  } catch (const std::exception &e) {
    reject(@"LANGUAGE_ID_IDENTIFY_FAILED", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"Failed to start SLID live pipeline", nil);
  }
}

@end
