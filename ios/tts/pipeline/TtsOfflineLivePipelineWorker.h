#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "../native/sherpa-onnx-tts-wrapper.h"

class TtsOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  TtsOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<TxtLiveEntry> textInput,
    std::shared_ptr<PaLiveEntry> audioOutput,
    sherpaonnx::TtsWrapper *wrapper,
    int32_t defaultSid,
    float defaultSpeed,
    std::optional<sherpaonnx::VoiceCloneOptions> voiceClone,
    std::optional<std::string> defaultLang = std::nullopt
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioOutput_;
  sherpaonnx::TtsWrapper *wrapper_ = nullptr;
  int32_t defaultSid_ = 0;
  float defaultSpeed_ = 1.0f;
  std::optional<sherpaonnx::VoiceCloneOptions> voiceClone_;
  std::optional<std::string> defaultLang_;
};
