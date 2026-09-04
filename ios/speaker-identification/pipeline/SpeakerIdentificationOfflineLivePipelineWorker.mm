#include "SpeakerIdentificationOfflineLivePipelineWorker.h"

#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"

#include <algorithm>
#include <cstdio>
#include <stdexcept>
#include <string>

namespace {

std::string BuildSidPayloadJson(const std::string &speakerNameOrEmpty) {
  if (speakerNameOrEmpty.empty()) {
    return "{\"source\":\"sid\",\"speakerName\":null}";
  }
  std::string escaped;
  escaped.reserve(speakerNameOrEmpty.size());
  for (char c : speakerNameOrEmpty) {
    if (c == '\\' || c == '"') {
      escaped.push_back('\\');
    }
    escaped.push_back(c);
  }
  return std::string("{\"source\":\"sid\",\"speakerName\":\"") + escaped + "\"}";
}

}  // namespace

SpeakerIdentificationOfflineLivePipelineWorker::SpeakerIdentificationOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::string audioInBufferId,
  std::string segmentsOutBufferId,
  std::shared_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper> extractor,
  std::shared_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper> manager,
  float threshold
)
  : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    audioInBufferId_(std::move(audioInBufferId)),
    segmentsOutBufferId_(std::move(segmentsOutBufferId)),
    extractor_(std::move(extractor)),
    manager_(std::move(manager)),
    threshold_(threshold)
{}

void SpeakerIdentificationOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) return;
  if (!audioInput_ || !extractor_ || !manager_) {
    throw std::runtime_error("Invalid SID live pipeline worker state");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);
  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  auto samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
  if (samples.empty()) return;

  auto embedding = extractor_->computeFromSamples(
    samples,
    static_cast<int32_t>(speech.sampleRate)
  );
  if (embedding.empty()) {
    const std::string err = extractor_->lastError();
    throw std::runtime_error(
      err.empty() ? "Speaker embedding compute failed" : err
    );
  }

  std::string matched = manager_->search(embedding, threshold_);
  // Trim whitespace
  while (!matched.empty() && (matched.back() == ' ' || matched.back() == '\t' || matched.back() == '\n')) {
    matched.pop_back();
  }
  size_t start = 0;
  while (start < matched.size() && (matched[start] == ' ' || matched[start] == '\t' || matched[start] == '\n')) {
    start++;
  }
  if (start > 0) matched = matched.substr(start);

  const std::string payloadJson = BuildSidPayloadJson(matched);
  const std::string sourceAudioBufferId =
    speech.sourceAudioBufferId.empty() ? audioInBufferId_ : speech.sourceAudioBufferId;

  std::string segmentId;
  int segmentIndex = -1;
  std::string error;
  const bool ok = seg_live_append_segment(
    segmentsOutBufferId_,
    "speech",
    sourceAudioBufferId,
    speech.startSample,
    speech.endSample,
    speech.sampleRate,
    speech.durationMs,
    speech.hasConfidence,
    speech.confidence,
    payloadJson,
    &segmentId,
    &segmentIndex,
    &error
  );
  if (!ok) {
    throw std::runtime_error(
      error.empty() ? "Failed to append SID labeled segment" : error
    );
  }

  addUnitsWritten(1);
}
