#include "TtsOfflineLivePipelineWorker.h"

#include <stdexcept>

TtsOfflineLivePipelineWorker::TtsOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<TxtLiveEntry> textInput,
  std::shared_ptr<PaLiveEntry> audioOutput,
  std::shared_ptr<sherpaonnx::TtsWrapper> wrapper,
  int32_t defaultSid,
  float defaultSpeed,
  std::optional<sherpaonnx::VoiceCloneOptions> voiceClone,
  std::optional<std::string> defaultLang,
  std::optional<int32_t> defaultNumSteps,
  std::vector<std::vector<int32_t>> defaultPhonemeCodepoints,
  std::vector<std::vector<std::string>> defaultTokens
)
  : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      nullptr,
      "",
      textInput
    ),
    audioOutput_(std::move(audioOutput)),
    wrapper_(std::move(wrapper)),
    defaultSid_(defaultSid),
    defaultSpeed_(defaultSpeed),
    voiceClone_(std::move(voiceClone)),
    defaultLang_(std::move(defaultLang)),
    defaultNumSteps_(std::move(defaultNumSteps)),
    defaultPhonemeCodepoints_(std::move(defaultPhonemeCodepoints)),
    defaultTokens_(std::move(defaultTokens))
{}

void TtsOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentText>(segment)) return;
  if (!audioOutput_ || !wrapper_) {
    throw std::runtime_error("Invalid offline live TTS worker state");
  }

  const auto &textSeg = std::get<CommittedSegmentText>(segment);
  const bool hasPhonemes =
    !defaultPhonemeCodepoints_.empty() ||
    !defaultTokens_.empty() ||
    (voiceClone_.has_value() &&
     (!voiceClone_->phoneme_codepoints.empty() || !voiceClone_->tokens.empty()));
  if (textSeg.text.empty() && !hasPhonemes) return;

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
  if (!genOpt.has_value()) {
    sherpaonnx::VoiceCloneOptions nonClone;
    bool any = false;
    if (defaultLang_.has_value() && !defaultLang_->empty()) {
      nonClone.extra["lang"] = *defaultLang_;
      any = true;
    }
    if (defaultNumSteps_.has_value()) {
      nonClone.apply_num_steps = true;
      nonClone.num_steps = *defaultNumSteps_;
      any = true;
    }
    if (!defaultPhonemeCodepoints_.empty()) {
      nonClone.phoneme_codepoints = defaultPhonemeCodepoints_;
      any = true;
    }
    if (!defaultTokens_.empty()) {
      nonClone.tokens = defaultTokens_;
      any = true;
    }
    if (any) {
      genOpt = std::move(nonClone);
    }
  } else {
    if (genOpt->phoneme_codepoints.empty()) {
      genOpt->phoneme_codepoints = defaultPhonemeCodepoints_;
    }
    if (genOpt->tokens.empty()) {
      genOpt->tokens = defaultTokens_;
    }
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
