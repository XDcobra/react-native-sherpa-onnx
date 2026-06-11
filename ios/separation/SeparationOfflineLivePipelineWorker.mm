#include "SeparationOfflineLivePipelineWorker.h"

#include <algorithm>
#include <stdexcept>

SeparationOfflineLivePipelineWorker::SeparationOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::vector<std::shared_ptr<PaLiveEntry>> audioOutputs,
  sherpaonnx::SeparationWrapper *wrapper
) : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    audioOutputs_(std::move(audioOutputs)),
    wrapper_(wrapper)
{}

void SeparationOfflineLivePipelineWorker::onSegmentCommitted(const CommittedSegmentRef &segment) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) {
    throw std::runtime_error("Expected speech segment in separation live overload");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);

  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  auto samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
  if (samples.empty()) return;

  auto processResult = wrapper_->processMonoSamples(samples, static_cast<int32_t>(speech.sampleRate));
  if (!processResult.success) {
    const std::string msg = processResult.error.empty()
      ? "Failed to separate audio chunk"
      : processResult.error;
    throw std::runtime_error(msg);
  }

  if (processResult.stems.size() != audioOutputs_.size()) {
    throw std::runtime_error("SEPARATION_ERROR: native separation stem count mismatch");
  }

  int64_t stem0SamplesWritten = 0;
  for (size_t i = 0; i < processResult.stems.size(); ++i) {
    const auto &stem = processResult.stems[i];
    if (stem.samples.empty()) continue;

    auto &audioOutput = audioOutputs_[i];
    if (audioOutput->sampleRate != speech.sampleRate) {
      throw std::runtime_error(
        "SEPARATION_SAMPLE_RATE_MISMATCH: live audio out[" + std::to_string(i) + "] is " +
        std::to_string(audioOutput->sampleRate) + " Hz; chunk is " +
        std::to_string(speech.sampleRate) + " Hz"
      );
    }

    auto appendResult = audioOutput->tryAppendSamples(
      stem.samples.data(),
      stem.samples.size(),
      stem.sampleRate,
      std::string(kPaAppendSourceSeparation)
    );
    if (appendResult == PaLiveEntry::AppendResult::BUFFER_FINALIZED) {
      stop();
      return;
    }
    if (appendResult == PaLiveEntry::AppendResult::APPENDED && i == 0) {
      stem0SamplesWritten = static_cast<int64_t>(stem.samples.size());
    }
  }

  if (stem0SamplesWritten > 0) {
    addUnitsWritten(stem0SamplesWritten);
  }
}
