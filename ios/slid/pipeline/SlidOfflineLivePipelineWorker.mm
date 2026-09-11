#include "SlidOfflineLivePipelineWorker.h"

#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kMinDurationMs = 1500;

std::string BuildLanguageIdPayloadJson(const std::string &lang) {
  std::string escaped;
  escaped.reserve(lang.size());
  for (char c : lang) {
    if (c == '\\' || c == '"') {
      escaped.push_back('\\');
    }
    escaped.push_back(c);
  }
  return std::string("{\"source\":\"languageId\",\"lang\":\"") + escaped + "\"}";
}

}  // namespace

SlidOfflineLivePipelineWorker::SlidOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::string audioInBufferId,
  std::shared_ptr<TxtLiveEntry> textOutput,
  std::string targetSegmentsOutBufferId,
  std::shared_ptr<sherpaonnx::language_id::bridge::LanguageIdInstanceState> slidState
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
    textOutput_(std::move(textOutput)),
    targetSegmentsOutBufferId_(std::move(targetSegmentsOutBufferId)),
    slidState_(std::move(slidState))
{}

void SlidOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) return;
  if (!audioInput_ || !textOutput_ || !slidState_ || slidState_->handle == nullptr) {
    throw std::runtime_error("Invalid SLID live pipeline worker state");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);
  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  const int durationMs = speech.durationMs > 0
      ? speech.durationMs
      : ((speech.sampleRate > 0) ? (frameCount * 1000) / speech.sampleRate : 0);
  if (durationMs < kMinDurationMs) {
    return;
  }

  auto samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
  if (samples.empty()) return;

  std::string lang;
  SherpaOnnxOfflineStream *stream =
      SherpaOnnxSpokenLanguageIdentificationCreateOfflineStream(slidState_->handle);
  if (stream != nullptr) {
    SherpaOnnxAcceptWaveformOffline(
        stream,
        speech.sampleRate,
        samples.data(),
        static_cast<int32_t>(samples.size()));
    const SherpaOnnxSpokenLanguageIdentificationResult *result =
        SherpaOnnxSpokenLanguageIdentificationCompute(slidState_->handle, stream);
    SherpaOnnxDestroyOfflineStream(stream);
    if (result != nullptr && result->lang != nullptr) {
      lang = result->lang;
      SherpaOnnxDestroySpokenLanguageIdentificationResult(result);
    }
  }

  // Trim whitespace
  while (!lang.empty() && (lang.back() == ' ' || lang.back() == '\t' || lang.back() == '\n')) {
    lang.pop_back();
  }
  size_t start = 0;
  while (start < lang.size() && (lang[start] == ' ' || lang[start] == '\t' || lang[start] == '\n')) {
    start++;
  }
  if (start > 0) lang = lang.substr(start);

  if (lang.empty()) return;

  const float startTime =
      speech.sampleRate > 0
          ? static_cast<float>(speech.startSample) / static_cast<float>(speech.sampleRate)
          : 0.f;
  const float endTime =
      speech.sampleRate > 0
          ? static_cast<float>(speech.endSample) / static_cast<float>(speech.sampleRate)
          : 0.f;

  std::vector<std::string> tokens;
  std::vector<float> timestamps = { startTime, endTime };
  std::string err;
  NSDictionary *meta = @{ @"durationMs": @(durationMs) };
  if (!txt_live_commit_segment(
        textOutput_,
        lang,
        tokens,
        timestamps,
        "language_id",
        meta,
        &err
      )) {
    throw std::runtime_error(
      err.empty() ? "Failed to commit SLID text segment" : err
    );
  }
  addUnitsWritten(static_cast<int64_t>(lang.size()));

  if (targetSegmentsOutBufferId_.empty()) return;

  const std::string payloadJson = BuildLanguageIdPayloadJson(lang);
  const std::string sourceAudioBufferId =
      speech.sourceAudioBufferId.empty() ? audioInBufferId_ : speech.sourceAudioBufferId;

  std::string segmentId;
  int segmentIndex = -1;
  std::string appendError;
  const bool ok = seg_live_append_segment(
    targetSegmentsOutBufferId_,
    "speech",
    sourceAudioBufferId,
    speech.startSample,
    speech.endSample,
    speech.sampleRate,
    durationMs,
    speech.hasConfidence,
    speech.confidence,
    payloadJson,
    &segmentId,
    &segmentIndex,
    &appendError
  );
  if (!ok) {
    throw std::runtime_error(
      appendError.empty() ? "Failed to append SLID labeled segment" : appendError
    );
  }
}
