#pragma once

#include "../../livePipeline/OfflineLivePipelineWorker.h"
#include "../native/sherpa-onnx-tts-wrapper.h"

#include <memory>
#include <optional>
#include <string>

class TtsOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  TtsOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<TxtLiveEntry> textInput,
    std::shared_ptr<PaLiveEntry> audioOutput,
    std::shared_ptr<sherpaonnx::TtsWrapper> wrapper,
    int32_t defaultSid,
    float defaultSpeed,
    std::optional<sherpaonnx::VoiceCloneOptions> voiceClone,
    std::optional<std::string> defaultLang = std::nullopt
  );

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioOutput_;
  std::shared_ptr<sherpaonnx::TtsWrapper> wrapper_;
  int32_t defaultSid_ = 0;
  float defaultSpeed_ = 1.0f;
  std::optional<sherpaonnx::VoiceCloneOptions> voiceClone_;
  std::optional<std::string> defaultLang_;
};
