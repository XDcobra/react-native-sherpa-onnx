#ifndef SHERPA_ONNX_DIARIZATION_PYANNOTE_SEGMENTATION_MODEL_H
#define SHERPA_ONNX_DIARIZATION_PYANNOTE_SEGMENTATION_MODEL_H

#include "diarization-types.h"
#include "powerset.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

struct PyannoteLoadOptions {
  std::string model_path;
  float window_shift_ratio = 0.1f;
  int32_t num_threads = 1;
  std::string provider = "cpu";
  bool debug = false;
};

/**
 * Own Ort::Session for a pyannote / reverb speaker-segmentation ONNX.
 * Metadata is read safely (never _Exit). Hard compile requirement for ORT.
 */
class PyannoteSegmentationModel {
 public:
  PyannoteSegmentationModel();
  ~PyannoteSegmentationModel();

  PyannoteSegmentationModel(const PyannoteSegmentationModel&) = delete;
  PyannoteSegmentationModel& operator=(const PyannoteSegmentationModel&) =
      delete;

  Status Load(const PyannoteLoadOptions& options);

  bool isLoaded() const;
  const PyannoteMeta& meta() const { return meta_; }
  const PowersetDecoder& powerset() const { return powerset_; }

  /**
   * Run one window. \p samples must contain exactly meta().window_size floats.
   * On success, \p out_logits is row-major (num_frames × num_classes).
   */
  Status ForwardWindow(const float* samples, int32_t num_samples,
                       std::vector<float>* out_logits,
                       int32_t* out_num_frames) const;

  void Release();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
  PyannoteMeta meta_{};
  PowersetDecoder powerset_{};
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_PYANNOTE_SEGMENTATION_MODEL_H
