#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "../native/sherpa-onnx-stt-wrapper.h"

#include <memory>

class SttOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  SttOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::shared_ptr<TxtLiveEntry> textOutput,
    std::shared_ptr<sherpaonnx::SttWrapper> wrapper
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioInput_;
  std::shared_ptr<TxtLiveEntry> textOutput_;
  std::shared_ptr<sherpaonnx::SttWrapper> wrapper_;
};
