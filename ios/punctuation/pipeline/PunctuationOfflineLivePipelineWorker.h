#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"

class PunctuationOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  PunctuationOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<TxtLiveEntry> textInput,
    std::string textSegmentInputBufferId,
    std::shared_ptr<TxtLiveEntry> textOutput,
    std::string punctuationInstanceId
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<TxtLiveEntry> textOutput_;
  std::string punctuationInstanceId_;
};
