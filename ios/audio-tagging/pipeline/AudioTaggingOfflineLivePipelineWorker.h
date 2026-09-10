#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "../../audio-tagging/core/AudioTaggingBridgeState.h"

#include <memory>
#include <string>

class AudioTaggingOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  AudioTaggingOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::string audioInBufferId,
    std::shared_ptr<TxtLiveEntry> textOutput,
    std::string targetSegmentsOutBufferId,
    std::shared_ptr<sherpaonnx::audio_tagging::bridge::AudioTaggingInstanceState> taggingState,
    int32_t topK
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::string audioInBufferId_;
  std::shared_ptr<TxtLiveEntry> textOutput_;
  std::string targetSegmentsOutBufferId_;
  std::shared_ptr<sherpaonnx::audio_tagging::bridge::AudioTaggingInstanceState> taggingState_;
  int32_t topK_;
};
