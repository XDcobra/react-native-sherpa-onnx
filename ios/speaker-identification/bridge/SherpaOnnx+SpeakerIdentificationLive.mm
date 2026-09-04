#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../speaker-embedding/core/SpeakerEmbeddingBridgeState.h"
#include "../pipeline/SpeakerIdentificationOfflineLivePipelineWorker.h"
#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include <cmath>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>

@implementation SherpaOnnx (SpeakerIdentificationLive)

- (void)startSpeakerIdentificationOfflineLivePipeline:(NSString *)instanceId
                                            managerId:(NSString *)managerId
                                  audioInLiveBufferId:(NSString *)audioInLiveBufferId
                              segmentsOutLiveBufferId:(NSString *)segmentsOutLiveBufferId
                                              options:(JS::NativeSherpaOnnx::SpecStartSpeakerIdentificationOfflineLivePipelineOptions &)options
                                              resolve:(RCTPromiseResolveBlock)resolve
                                               reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"SID_INVALID_ARGUMENT", @"instanceId is required", nil);
    return;
  }
  if (managerId == nil || [managerId length] == 0) {
    reject(@"SID_INVALID_ARGUMENT", @"managerId is required", nil);
    return;
  }
  if (audioInLiveBufferId == nil || [audioInLiveBufferId length] == 0) {
    reject(@"SID_INVALID_ARGUMENT", @"audioInLiveBufferId is required", nil);
    return;
  }
  if (segmentsOutLiveBufferId == nil || [segmentsOutLiveBufferId length] == 0) {
    reject(@"SID_INVALID_ARGUMENT", @"segmentsOutLiveBufferId is required", nil);
    return;
  }

  NSString *attachedSegmentationEngineId = options.attachedSegmentationEngineId();
  if (attachedSegmentationEngineId == nil || [attachedSegmentationEngineId length] == 0) {
    reject(@"SID_INVALID_ARGUMENT", @"options.attachedSegmentationEngineId is required", nil);
    return;
  }

  NSString *segmentLiveBufferId = options.segmentLiveBufferId();
  if (segmentLiveBufferId == nil || [segmentLiveBufferId length] == 0) {
    reject(@"SID_INVALID_ARGUMENT", @"options.segmentLiveBufferId is required", nil);
    return;
  }

  const float threshold = static_cast<float>(options.threshold());
  if (!std::isfinite(threshold)) {
    reject(@"SID_INVALID_ARGUMENT", @"options.threshold must be a finite number", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string managerIdStr = [managerId UTF8String];
  std::string audioInIdStr = [audioInLiveBufferId UTF8String];
  std::string segmentsOutIdStr = [segmentsOutLiveBufferId UTF8String];
  std::string attachedEngineIdStr = [attachedSegmentationEngineId UTF8String];
  std::string segmentBufferIdStr = [segmentLiveBufferId UTF8String];

  sherpaonnx::SpeakerEmbeddingExtractorWrapper *extractor = nullptr;
  sherpaonnx::SpeakerEmbeddingManagerWrapper *manager = nullptr;
  {
    using namespace sherpaonnx::speaker_embedding::bridge;
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto eit = g_speaker_embedding_extractors.find(instanceIdStr);
    if (eit == g_speaker_embedding_extractors.end() ||
        eit->second == nullptr ||
        eit->second->wrapper == nullptr ||
        !eit->second->wrapper->isInitialized()) {
      reject(@"SID_INSTANCE_NOT_FOUND", @"Speaker embedding extractor not initialized", nil);
      return;
    }
    auto mit = g_speaker_embedding_managers.find(managerIdStr);
    if (mit == g_speaker_embedding_managers.end() ||
        mit->second == nullptr ||
        mit->second->wrapper == nullptr ||
        !mit->second->wrapper->isInitialized()) {
      reject(@"SID_MANAGER_NOT_FOUND", @"Speaker embedding manager not found", nil);
      return;
    }
    extractor = eit->second->wrapper.get();
    manager = mit->second->wrapper.get();
  }

  auto inputEntry = pa_get_live_entry(audioInIdStr);
  if (!inputEntry) {
    reject(
      @"SID_PIPELINE_AUDIO_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Input live audio buffer not found: %@", audioInLiveBufferId],
      nil
    );
    return;
  }

  auto segmentsOutEntry = seg_get_live_entry(segmentsOutIdStr);
  if (!segmentsOutEntry) {
    reject(
      @"SID_PIPELINE_SEGMENT_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Output live segment buffer not found: %@", segmentsOutLiveBufferId],
      nil
    );
    return;
  }
  (void)segmentsOutEntry;

  auto segmentInputEntry = seg_get_live_entry(segmentBufferIdStr);
  if (!segmentInputEntry) {
    reject(
      @"SID_PIPELINE_SEGMENT_BUFFER_NOT_FOUND",
      [NSString stringWithFormat:@"Input live segment buffer not found: %@", segmentLiveBufferId],
      nil
    );
    return;
  }
  (void)segmentInputEntry;

  try {
    std::string pipelineId =
      std::string("sid_live_") +
      std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    auto worker = std::make_shared<SpeakerIdentificationOfflineLivePipelineWorker>(
      pipelineId,
      attachedEngineIdStr,
      inputEntry,
      segmentBufferIdStr,
      audioInIdStr,
      segmentsOutIdStr,
      extractor,
      manager,
      threshold
    );

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      g_streaming_pipelines[pipelineId] = worker;
    }

    worker->start();
    so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

    resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] ?: @"" });
  } catch (const std::exception &e) {
    reject(@"SID_LABEL_FAILED", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"SID_LABEL_FAILED", @"Failed to start SID live pipeline", nil);
  }
}

@end
