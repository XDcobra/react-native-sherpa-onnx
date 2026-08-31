#include "SeparationOfflineLivePipelineWorker.h"

#include "../separation/core/SeparationBridgeState.h"

#include <algorithm>
#include <new>
#include <stdexcept>

SeparationOfflineLivePipelineWorker::SeparationOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::vector<std::shared_ptr<PaLiveEntry>> audioOutputs,
  std::string separationInstanceId
) : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    audioOutputs_(std::move(audioOutputs)),
    separationInstanceId_(std::move(separationInstanceId))
{}

void SeparationOfflineLivePipelineWorker::onSegmentCommitted(const CommittedSegmentRef &segment) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) {
    throw std::runtime_error("Expected speech segment in separation live overload");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);

  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  std::vector<float> samples;
  sherpaonnx::SeparationProcessResult processResult;
  try {
    samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
    if (samples.empty()) return;

    {
      std::lock_guard<std::mutex> lock(
          sherpaonnx::separation::bridge::g_separation_mutex);
      auto it = sherpaonnx::separation::bridge::g_separation_instances.find(
          separationInstanceId_);
      if (it == sherpaonnx::separation::bridge::g_separation_instances.end() ||
          it->second->wrapper == nullptr) {
        throw std::runtime_error("SEPARATION_ERROR: Separation instance not found");
      }
      processResult = it->second->wrapper->processMonoSamples(
          samples,
          static_cast<int32_t>(speech.sampleRate));
    }
  } catch (const std::bad_alloc &) {
    throw std::runtime_error(
        "OFFLINE_OOM: Not enough memory for offline source separation");
  }

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
      PaLiveAppendOrigin::pipeline(PaLivePipelineWriter::Separation)
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

void SeparationOfflineLivePipelineWorker::onRelease() {
  std::lock_guard<std::mutex> lock(
      sherpaonnx::separation::bridge::g_separation_mutex);
  auto it = sherpaonnx::separation::bridge::g_separation_instances.find(
      separationInstanceId_);
  if (it != sherpaonnx::separation::bridge::g_separation_instances.end() &&
      it->second->activeLivePipelineId == pipelineId) {
    it->second->activeLivePipelineId.clear();
  }
}
