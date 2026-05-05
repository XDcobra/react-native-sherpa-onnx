#include "SttOfflineLivePipelineWorker.h"

#include <algorithm>
#include <stdexcept>

SttOfflineLivePipelineWorker::SttOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::shared_ptr<TxtLiveEntry> textOutput,
  sherpaonnx::SttWrapper *wrapper,
  int chunkSize
)
  : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    textOutput_(std::move(textOutput)),
    wrapper_(wrapper),
    chunkSize_(std::max(1, chunkSize))
{}

void SttOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) return;
  if (!audioInput_ || !textOutput_ || !wrapper_) {
    throw std::runtime_error("Invalid STT live pipeline worker state");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);
  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  auto samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
  if (samples.empty()) return;

  // Feed in chunkSize_ batches when the segment is long; one-shot for short segments.
  auto result = wrapper_->transcribeSamplesChunked(
    samples,
    static_cast<int32_t>(speech.sampleRate),
    chunkSize_
  );

  std::string err;
  if (!txt_live_commit_segment(
        textOutput_,
        result.text,
        result.tokens,
        result.timestamps,
        "segmentation_engine",
        nil,
        &err
      )) {
    throw std::runtime_error(
      err.empty() ? "Failed to commit STT text segment" : err
    );
  }

  addUnitsWritten(static_cast<int64_t>(result.text.size()));
}
