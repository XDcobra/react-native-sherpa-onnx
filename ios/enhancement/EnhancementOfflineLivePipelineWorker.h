#pragma once

#include "../livePipeline/OfflineLivePipelineWorker.h"
#include "../audio/pipeline/PaLiveEntry.h"
#include "sherpa-onnx-enhancement-wrapper.h"

#include <memory>
#include <string>

class EnhancementOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  EnhancementOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::shared_ptr<PaLiveEntry> audioOutput,
    sherpaonnx::EnhancementWrapper *wrapper
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::shared_ptr<PaLiveEntry> audioOutput_;
  sherpaonnx::EnhancementWrapper *wrapper_;
};
