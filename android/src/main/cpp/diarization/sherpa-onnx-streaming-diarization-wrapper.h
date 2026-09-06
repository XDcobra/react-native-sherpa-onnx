#ifndef SHERPA_ONNX_STREAMING_DIARIZATION_WRAPPER_H
#define SHERPA_ONNX_STREAMING_DIARIZATION_WRAPPER_H

#include "streaming-diarizer-interface.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace sherpaonnx {

struct StreamingDiarizationSegmentDto {
  float start = 0.0f;
  float end = 0.0f;
  int32_t speaker = 0;
};

struct StreamingDiarizationInitResult {
  bool success = false;
  std::string error;
  std::string errorCode;
  int32_t sampleRate = 16000;
  int32_t maxSpeakers = 4;
  int32_t feedSamples = 160000;
  int32_t strideSamples = 158720;
  float latencySeconds = 10.0f;
};

struct StreamingDiarizationFeedResult {
  bool success = false;
  std::string error;
  std::string errorCode;
  std::vector<StreamingDiarizationSegmentDto> segments;
};

/**
 * Portable C++ facade over streaming diarization engines.
 * Manages audio buffer accumulation, window sliding, lifecycle, and thread safety.
 * No platform-specific includes (JNI or ObjC) — compiled on Android, iOS, and host.
 */
class StreamingDiarizationWrapper {
 public:
  StreamingDiarizationWrapper();
  ~StreamingDiarizationWrapper();

  StreamingDiarizationInitResult initialize(
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
      int32_t medianWindow);

  StreamingDiarizationFeedResult feed(const float* samples, size_t count);
  StreamingDiarizationFeedResult flush();
  void reset();
  void release();
  bool isInitialized() const;

  int32_t getSampleRate() const;
  int32_t getFeedSamples() const;
  int32_t getStrideSamples() const;
  float getLatency() const;

 private:
  mutable std::mutex mutex_;
  std::unique_ptr<sherpaonnx::diarization::IStreamingDiarizer> diarizer_;

  std::vector<float> audio_buffer_;
  int64_t elapsed_samples_ = 0;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_STREAMING_DIARIZATION_WRAPPER_H
