#ifndef SHERPA_ONNX_DIARIZATION_PYANNOTE_SEGMENTATION_SESSION_H
#define SHERPA_ONNX_DIARIZATION_PYANNOTE_SEGMENTATION_SESSION_H

#include "diarization-types.h"
#include "pyannote-segmentation-model.h"
#include "speaker-timeline.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

struct PyannoteSegOptions {
  std::string model_path;
  float window_shift_ratio = 0.1f;
  float min_duration_on = 0.3f;
  float min_duration_off = 0.5f;
  int32_t num_threads = 1;
  std::string provider = "cpu";
  bool debug = false;
};

/** Speech union span in seconds (wall-clock; map with source sample rate). */
struct PyannoteSpeechSpan {
  float start = 0.f;
  float end = 0.f;
};

/**
 * Layers 1–3 only: pyannote ONNX → powerset → union timeline.
 * No embedding / clustering. Used by the segmentation-engine evaluator.
 */
class PyannoteSegmentationSession {
 public:
  PyannoteSegmentationSession();
  ~PyannoteSegmentationSession();

  Status Initialize(const PyannoteSegOptions& options);
  void Release();
  bool isInitialized() const;

  const PyannoteMeta& meta() const;

  /**
   * Run offline union segmentation. Samples may be at any rate; they are
   * resampled to the model sample rate when needed. Output times are seconds.
   */
  Status ProcessMono(const float* samples, int32_t n, int32_t sample_rate,
                     std::vector<PyannoteSpeechSpan>* out);

 private:
  std::vector<float> ResampleIfNeeded(const float* input, int32_t n,
                                      int32_t src_rate,
                                      int32_t dst_rate) const;

  PyannoteSegmentationModel segmentation_;
  TimelineConfig timeline_config_{};
  bool initialized_ = false;
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_PYANNOTE_SEGMENTATION_SESSION_H
