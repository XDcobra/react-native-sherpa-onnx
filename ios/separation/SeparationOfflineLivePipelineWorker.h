#pragma once

#include "../livePipeline/OfflineLivePipelineWorker.h"
#include "../audio/pipeline/PaLiveEntry.h"

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
    std::string separationInstanceId
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;
  void onRelease() override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::vector<std::shared_ptr<PaLiveEntry>> audioOutputs_;
  std::string separationInstanceId_;
};
