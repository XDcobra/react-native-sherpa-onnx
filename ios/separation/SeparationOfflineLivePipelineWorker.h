#pragma once

#include "../livePipeline/OfflineLivePipelineWorker.h"
#include "../audio/pipeline/PaLiveEntry.h"
#include "sherpa-onnx-separation-wrapper.h"

#include <memory>
#include <string>
#include <vector>

class SeparationOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  SeparationOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::vector<std::shared_ptr<PaLiveEntry>> audioOutputs,
    sherpaonnx::SeparationWrapper *wrapper
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::vector<std::shared_ptr<PaLiveEntry>> audioOutputs_;
  sherpaonnx::SeparationWrapper *wrapper_;
};
