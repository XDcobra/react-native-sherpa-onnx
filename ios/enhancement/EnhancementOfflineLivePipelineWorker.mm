#include "EnhancementOfflineLivePipelineWorker.h"
#include <stdexcept>
#include <algorithm>

EnhancementOfflineLivePipelineWorker::EnhancementOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::shared_ptr<PaLiveEntry> audioOutput,
  sherpaonnx::EnhancementWrapper *wrapper
) : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    audioOutput_(std::move(audioOutput)),
    wrapper_(wrapper)
{}

void EnhancementOfflineLivePipelineWorker::onSegmentCommitted(const CommittedSegmentRef &segment) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) {
    throw std::runtime_error("Expected speech segment in enhancement live overload");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);

  if (audioOutput_->sampleRate != speech.sampleRate) {
    throw std::runtime_error(
      "ENHANCEMENT_SAMPLE_RATE_MISMATCH: live audio out is " + std::to_string(audioOutput_->sampleRate) +
      " Hz; chunk is " + std::to_string(speech.sampleRate) + " Hz"
    );
  }

  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  auto samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
  if (samples.empty()) return;

  auto result = wrapper_->runSamples(samples, static_cast<int32_t>(speech.sampleRate));

  if (result.samples.empty()) return;

  audioOutput_->appendSamples(
    result.samples.data(),
    result.samples.size(),
    result.sampleRate,
    kPaAppendSourceEnhancement
  );

  addUnitsWritten(static_cast<int64_t>(result.samples.size()));
}
