#include "sherpa-onnx-streaming-diarization-wrapper.h"
#include "sortformer-streaming-model.h"

#include <algorithm>

namespace sherpaonnx {

StreamingDiarizationWrapper::StreamingDiarizationWrapper() = default;
StreamingDiarizationWrapper::~StreamingDiarizationWrapper() { release(); }

bool StreamingDiarizationWrapper::isInitialized() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return diarizer_ != nullptr && diarizer_->IsInitialized();
}

int32_t StreamingDiarizationWrapper::getSampleRate() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return diarizer_ ? diarizer_->GetInfo().sample_rate : 16000;
}

int32_t StreamingDiarizationWrapper::getFeedSamples() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return diarizer_ ? diarizer_->GetInfo().FeedSamples() : 160000;
}

int32_t StreamingDiarizationWrapper::getStrideSamples() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return diarizer_ ? diarizer_->GetInfo().StrideSamples() : 158720;
}

float StreamingDiarizationWrapper::getLatency() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return diarizer_ ? diarizer_->GetInfo().LatencySeconds() : 10.0f;
}

void StreamingDiarizationWrapper::release() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (diarizer_) {
    diarizer_->Release();
    diarizer_.reset();
  }
  audio_buffer_.clear();
  elapsed_samples_ = 0;
}

void StreamingDiarizationWrapper::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (diarizer_) {
    diarizer_->Reset();
  }
  audio_buffer_.clear();
  elapsed_samples_ = 0;
}

StreamingDiarizationInitResult StreamingDiarizationWrapper::initialize(
    const std::string& modelPath,
    const std::string& metadataPath,
    int32_t numThreads,
    const std::string& provider,
    bool debug,
    float onset,
    float offset,
    float padOnset,
    float padOffset,
    float minDurationOn,
    float minDurationOff,
    int32_t medianWindow) {
  std::lock_guard<std::mutex> lock(mutex_);

  StreamingDiarizationInitResult result;
  if (diarizer_) {
    diarizer_->Release();
    diarizer_.reset();
  }
  audio_buffer_.clear();
  elapsed_samples_ = 0;

  sherpaonnx::diarization::StreamingDiarizerConfig config;
  config.model_path = modelPath;
  config.metadata_path = metadataPath;
  config.num_threads = numThreads;
  config.provider = provider;
  config.debug = debug;
  config.onset = onset;
  config.offset = offset;
  config.pad_onset = padOnset;
  config.pad_offset = padOffset;
  config.min_duration_on = minDurationOn;
  config.min_duration_off = minDurationOff;
  config.median_window = medianWindow;

  auto model = std::make_unique<sherpaonnx::diarization::SortformerStreamingModel>();
  auto st = model->Initialize(config);
  if (!st.ok) {
    result.success = false;
    result.error = st.message;
    result.errorCode = st.code == sherpaonnx::diarization::kErrInvalidArgument
                           ? "INVALID_ARGUMENT"
                           : "MODEL_LOAD_FAILED";
    return result;
  }

  const auto& info = model->GetInfo();
  result.success = true;
  result.sampleRate = info.sample_rate;
  result.maxSpeakers = info.max_speakers;
  result.feedSamples = info.FeedSamples();
  result.strideSamples = info.StrideSamples();
  result.latencySeconds = info.LatencySeconds();

  audio_buffer_.clear();
  audio_buffer_.reserve(
      static_cast<size_t>(result.feedSamples + result.strideSamples + 16384));

  diarizer_ = std::move(model);
  return result;
}

StreamingDiarizationFeedResult StreamingDiarizationWrapper::feed(
    const float* samples, size_t count) {
  std::lock_guard<std::mutex> lock(mutex_);

  StreamingDiarizationFeedResult result;
  if (!diarizer_ || !diarizer_->IsInitialized()) {
    result.success = false;
    result.error = "Streaming diarizer is not initialized";
    result.errorCode = "NOT_INITIALIZED";
    return result;
  }

  if (samples != nullptr && count > 0) {
    audio_buffer_.insert(audio_buffer_.end(), samples, samples + count);
  }

  const size_t feed_samples =
      static_cast<size_t>(diarizer_->GetInfo().FeedSamples());
  const size_t stride_samples =
      static_cast<size_t>(diarizer_->GetInfo().StrideSamples());

  std::vector<sherpaonnx::diarization::DiarizationSegment> raw_segs;

  // Process sliding windows while enough samples are buffered
  while (audio_buffer_.size() >= feed_samples) {
    auto st = diarizer_->ProcessWindow(audio_buffer_.data(), feed_samples,
                                       elapsed_samples_, raw_segs);
    if (!st.ok) {
      result.success = false;
      result.error = st.message;
      result.errorCode = "INFERENCE_FAILED";
      return result;
    }

    // Slide buffer forward by stride
    audio_buffer_.erase(audio_buffer_.begin(),
                        audio_buffer_.begin() + static_cast<std::ptrdiff_t>(stride_samples));
    elapsed_samples_ += static_cast<int64_t>(stride_samples);
  }

  result.success = true;
  result.segments.reserve(raw_segs.size());
  for (const auto& s : raw_segs) {
    StreamingDiarizationSegmentDto dto;
    dto.start = s.start;
    dto.end = s.end;
    dto.speaker = s.speaker;
    result.segments.push_back(dto);
  }

  return result;
}

StreamingDiarizationFeedResult StreamingDiarizationWrapper::flush() {
  std::lock_guard<std::mutex> lock(mutex_);

  StreamingDiarizationFeedResult result;
  if (!diarizer_ || !diarizer_->IsInitialized()) {
    result.success = false;
    result.error = "Streaming diarizer is not initialized";
    result.errorCode = "NOT_INITIALIZED";
    return result;
  }

  std::vector<sherpaonnx::diarization::DiarizationSegment> raw_segs;

  if (!audio_buffer_.empty()) {
    auto st = diarizer_->Flush(audio_buffer_.data(), audio_buffer_.size(),
                               elapsed_samples_, raw_segs);
    if (!st.ok) {
      result.success = false;
      result.error = st.message;
      result.errorCode = "INFERENCE_FAILED";
      return result;
    }
    elapsed_samples_ += static_cast<int64_t>(audio_buffer_.size());
    audio_buffer_.clear();
  }

  result.success = true;
  result.segments.reserve(raw_segs.size());
  for (const auto& s : raw_segs) {
    StreamingDiarizationSegmentDto dto;
    dto.start = s.start;
    dto.end = s.end;
    dto.speaker = s.speaker;
    result.segments.push_back(dto);
  }

  return result;
}

} // namespace sherpaonnx
