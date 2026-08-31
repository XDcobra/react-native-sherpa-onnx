#include "EnhancementOfflineLivePipelineWorker.h"

#include "../enhancement/core/EnhancementBridgeState.h"

#include <algorithm>
#include <stdexcept>

EnhancementOfflineLivePipelineWorker::EnhancementOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::shared_ptr<PaLiveEntry> audioOutput,
  std::string enhancementInstanceId
) : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    audioOutput_(std::move(audioOutput)),
    enhancementInstanceId_(std::move(enhancementInstanceId))
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

  sherpaonnx::EnhancedAudioResult result;
  {
    std::lock_guard<std::mutex> lock(
        sherpaonnx::enhancement::bridge::g_enhancement_mutex);
    auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(
        enhancementInstanceId_);
    if (it == sherpaonnx::enhancement::bridge::g_enhancement_instances.end() ||
        it->second->wrapper == nullptr) {
      throw std::runtime_error("ENHANCEMENT_ERROR: Enhancement instance not found");
    }
    result = it->second->wrapper->runSamples(
        samples,
        static_cast<int32_t>(speech.sampleRate));
  }

  if (result.samples.empty()) return;

  audioOutput_->appendSamples(
    result.samples.data(),
    result.samples.size(),
    result.sampleRate,
    kPaAppendSourceEnhancement
  );

  addUnitsWritten(static_cast<int64_t>(result.samples.size()));
}

void EnhancementOfflineLivePipelineWorker::onRelease() {
  std::lock_guard<std::mutex> lock(
      sherpaonnx::enhancement::bridge::g_enhancement_mutex);
  auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(
      enhancementInstanceId_);
  if (it != sherpaonnx::enhancement::bridge::g_enhancement_instances.end() &&
      it->second->activeLivePipelineId == pipelineId) {
    it->second->activeLivePipelineId.clear();
  }
}
