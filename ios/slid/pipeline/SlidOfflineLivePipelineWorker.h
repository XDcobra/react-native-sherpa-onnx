#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "../../slid/core/LanguageIdBridgeState.h"

#include <memory>
#include <string>

class SlidOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  SlidOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::string audioInBufferId,
    std::shared_ptr<TxtLiveEntry> textOutput,
    std::string targetSegmentsOutBufferId,
    std::shared_ptr<sherpaonnx::language_id::bridge::LanguageIdInstanceState> slidState
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::string audioInBufferId_;
  std::shared_ptr<TxtLiveEntry> textOutput_;
  std::string targetSegmentsOutBufferId_;
  std::shared_ptr<sherpaonnx::language_id::bridge::LanguageIdInstanceState> slidState_;
};
