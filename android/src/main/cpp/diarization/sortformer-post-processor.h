#ifndef SHERPA_ONNX_DIARIZATION_SORTFORMER_POST_PROCESSOR_H
#define SHERPA_ONNX_DIARIZATION_SORTFORMER_POST_PROCESSOR_H

#include "diarization-types.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace sherpaonnx::diarization {

struct SortformerPostProcessorConfig {
  float onset = 0.5f;
  float offset = 0.5f;
  float pad_onset = 0.0f;
  float pad_offset = 0.0f;
  float min_duration_on = 0.0f;
  float min_duration_off = 0.5f;
  int32_t median_window = 11;
  int32_t sample_rate = 16000;
  int32_t max_speakers = 4;
  float frame_duration = 0.08f; // 80ms per model frame
};

class SortformerPostProcessor {
 public:
  explicit SortformerPostProcessor(const SortformerPostProcessorConfig& config = {});
  ~SortformerPostProcessor() = default;

  const SortformerPostProcessorConfig& config() const { return config_; }

  /**
   * Applies median filtering across time for each speaker column.
   *
   * @param preds Row-major matrix of shape (num_frames, num_speakers).
   * @param num_frames Number of time frames.
   * @param num_speakers Number of speaker channels.
   * @param out_filtered Output row-major matrix of shape (num_frames, num_speakers).
   */
  void ApplyMedianFilter(const float* preds, int32_t num_frames,
                         int32_t num_speakers, float* out_filtered);

  /**
   * Converts raw or filtered frame predictions to timestamped speaker segments.
   *
   * @param preds Row-major matrix of shape (num_frames, num_speakers).
   * @param num_frames Number of time frames.
   * @param num_speakers Number of speaker channels.
   * @param sample_offset Absolute sample index of frame 0 in the audio stream.
   * @param max_sample_bound Maximum sample index for clipping (e.g. sample_offset + chunk_samples).
   * @param out_segments Destination vector for newly extracted segments.
   */
  void Binarize(const float* preds, int32_t num_frames, int32_t num_speakers,
                int64_t sample_offset, int64_t max_sample_bound,
                std::vector<DiarizationSegment>& out_segments);

  /**
   * Combined pipeline: MedianFilter -> Binarize.
   */
  void Process(const float* raw_preds, int32_t num_frames, int32_t num_speakers,
               int64_t sample_offset, int64_t max_sample_bound,
               std::vector<DiarizationSegment>& out_segments);

 private:
  SortformerPostProcessorConfig config_;
  std::vector<float> filtered_scratch_;
};

} // namespace sherpaonnx::diarization

#endif // SHERPA_ONNX_DIARIZATION_SORTFORMER_POST_PROCESSOR_H
