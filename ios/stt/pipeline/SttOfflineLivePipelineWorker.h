#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "../native/sherpa-onnx-stt-wrapper.h"

class SttOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  SttOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::shared_ptr<TxtLiveEntry> textOutput,
    sherpaonnx::SttWrapper *wrapper,
    int chunkSize
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::shared_ptr<TxtLiveEntry> textOutput_;
  sherpaonnx::SttWrapper *wrapper_ = nullptr;
  int chunkSize_ = 3200;
};
