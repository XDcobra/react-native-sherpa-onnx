#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include <memory>
#include <string>

class SpeakerIdentificationOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  SpeakerIdentificationOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::string audioInBufferId,
    std::string segmentsOutBufferId,
    sherpaonnx::SpeakerEmbeddingExtractorWrapper *extractor,
    sherpaonnx::SpeakerEmbeddingManagerWrapper *manager,
    float threshold
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::string audioInBufferId_;
  std::string segmentsOutBufferId_;
  sherpaonnx::SpeakerEmbeddingExtractorWrapper *extractor_ = nullptr;
  sherpaonnx::SpeakerEmbeddingManagerWrapper *manager_ = nullptr;
  float threshold_ = 0.5f;
};
