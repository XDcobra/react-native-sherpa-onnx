#ifndef SHERPA_ONNX_DIARIZATION_STREAMING_DIARIZER_INTERFACE_H
#define SHERPA_ONNX_DIARIZATION_STREAMING_DIARIZER_INTERFACE_H

#include "diarization-types.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

struct StreamingDiarizerConfig {
  std::string model_path;
  std::string metadata_path;
  int32_t num_threads = 1;
  std::string provider = "cpu";
  bool debug = false;

  // Post-processing thresholds & parameters
  float onset = 0.5f;
  float offset = 0.5f;
  float pad_onset = 0.0f;
  float pad_offset = 0.0f;
  float min_duration_on = 0.0f;
  float min_duration_off = 0.5f;
  int32_t median_window = 11;
};

struct StreamingDiarizerInfo {
  std::string model_type = "sortformer";
  int32_t sample_rate = 16000;
  int32_t chunk_len = 124;       // Model frames per chunk (e.g. 124 = ~9.92s)
  int32_t right_context = 1;      // Future context frames (e.g. 1 = 80ms)
  int32_t fifo_len = 124;         // Max FIFO frames
  int32_t spkcache_len = 188;     // Max speaker cache frames
  int32_t max_speakers = 4;
  int32_t feature_dim = 128;      // Mel features
  int32_t embedding_dim = 512;
  int32_t subsampling = 8;        // Subsampling ratio (audio frames -> model frames)
  int32_t hop_length = 160;       // Audio hop length (10ms at 16kHz)

  int32_t FeedSamples() const {
    return (chunk_len + right_context) * subsampling * hop_length;
  }

  int32_t StrideSamples() const {
    return chunk_len * subsampling * hop_length;
  }

  float LatencySeconds() const {
    return static_cast<float>(chunk_len + right_context) * 0.08f;
  }
};

/**
 * Polymorphic interface for streaming speaker diarization engines.
 * Decouples pipeline workers and audio accumulation from specific model architectures.
 */
class IStreamingDiarizer {
 public:
  virtual ~IStreamingDiarizer() = default;

  virtual Status Initialize(const StreamingDiarizerConfig& config) = 0;
  virtual bool IsInitialized() const = 0;
  virtual void Release() = 0;
  virtual void Reset() = 0;

  /**
   * Process one audio window of FeedSamples() samples (16 kHz mono).
   * Appends newly finalized segments to out_segments (with absolute sample / second times).
   *
   * @param window Pointer to float audio samples (at least FeedSamples()).
   * @param num_samples Number of samples in window.
   * @param sample_offset Absolute sample index of the window start in the stream.
   * @param out_segments Destination vector to receive newly detected segments.
   */
  virtual Status ProcessWindow(const float* window, size_t num_samples,
                               int64_t sample_offset,
                               std::vector<DiarizationSegment>& out_segments) = 0;

  /**
   * Flush trailing buffered audio (less than FeedSamples()), zero-padding to feed size.
   * Emits final speaker segments.
   *
   * @param remaining Pointer to remaining audio samples.
   * @param num_samples Number of remaining samples.
   * @param sample_offset Absolute sample index of the remaining audio start.
   * @param out_segments Destination vector to receive final segments.
   */
  virtual Status Flush(const float* remaining, size_t num_samples,
                       int64_t sample_offset,
                       std::vector<DiarizationSegment>& out_segments) = 0;

  virtual const StreamingDiarizerInfo& GetInfo() const = 0;
};

} // namespace sherpaonnx::diarization

#endif // SHERPA_ONNX_DIARIZATION_STREAMING_DIARIZER_INTERFACE_H
