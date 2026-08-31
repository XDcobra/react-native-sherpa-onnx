#pragma once

#include "../livePipeline/OfflineLivePipelineWorker.h"
#include "../audio/pipeline/PaLiveEntry.h"

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
    std::string enhancementInstanceId
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;
  void onRelease() override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::shared_ptr<PaLiveEntry> audioOutput_;
  std::string enhancementInstanceId_;
};
