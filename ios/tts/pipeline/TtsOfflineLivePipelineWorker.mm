#include "TtsOfflineLivePipelineWorker.h"

#include <stdexcept>

TtsOfflineLivePipelineWorker::TtsOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<TxtLiveEntry> textInput,
  std::shared_ptr<PaLiveEntry> audioOutput,
  sherpaonnx::TtsWrapper *wrapper,
  int32_t defaultSid,
  float defaultSpeed,
  std::optional<sherpaonnx::VoiceCloneOptions> voiceClone,
  std::optional<std::string> defaultLang
)
  : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      nullptr,
      "",
      textInput
    ),
    audioOutput_(std::move(audioOutput)),
    wrapper_(wrapper),
    defaultSid_(defaultSid),
    defaultSpeed_(defaultSpeed),
    voiceClone_(std::move(voiceClone)),
    defaultLang_(std::move(defaultLang))
{}

void TtsOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentText>(segment)) return;
  if (!audioOutput_ || !wrapper_) {
    throw std::runtime_error("Invalid offline live TTS worker state");
  }

  const auto &textSeg = std::get<CommittedSegmentText>(segment);
  if (textSeg.text.empty()) return;

  int32_t effectiveSid = defaultSid_;
  float effectiveSpeed = defaultSpeed_;
  if (textSeg.meta != nil) {
    NSNumber *sidVal = textSeg.meta[@"sid"];
    if ([sidVal isKindOfClass:[NSNumber class]]) {
      effectiveSid = [sidVal intValue];
    }
    NSNumber *spdVal = textSeg.meta[@"speed"];
    if ([spdVal isKindOfClass:[NSNumber class]]) {
      effectiveSpeed = [spdVal floatValue];
    }
  }

  std::optional<sherpaonnx::VoiceCloneOptions> genOpt = voiceClone_;
  if (!genOpt.has_value() && defaultLang_.has_value() && !defaultLang_->empty()) {
    sherpaonnx::VoiceCloneOptions extraOnly;
    extraOnly.extra["lang"] = *defaultLang_;
    genOpt = std::move(extraOnly);
  }

  auto audio = wrapper_->generate(
    textSeg.text,
    effectiveSid,
    effectiveSpeed,
    genOpt
  );
  if (audio.samples.empty() || audio.sampleRate <= 0) return;

  auto appendResult = audioOutput_->tryAppendSamples(
    audio.samples.data(),
    audio.samples.size(),
    audio.sampleRate,
    PaLiveAppendOrigin::pipeline(PaLivePipelineWriter::Tts)
  );
  if (appendResult != PaLiveEntry::AppendResult::APPENDED) return;
  addUnitsWritten(static_cast<int64_t>(audio.samples.size()));
}
