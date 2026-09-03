#ifndef SHERPA_ONNX_DIARIZATION_POWERSET_H
#define SHERPA_ONNX_DIARIZATION_POWERSET_H

#include "diarization-types.h"

#include <cstdint>
#include <vector>

namespace sherpaonnx::diarization {

/**
 * Generic powerset mapping matching pyannote-audio order:
 * class 0 = empty set; then all subsets of size 1..max_classes
 * in lexicographic speaker order.
 *
 * mapping[class_index * num_speakers + speaker] is 0/1.
 */
class PowersetDecoder {
 public:
  Status Init(int32_t num_speakers, int32_t powerset_max_classes,
              int32_t expected_num_classes);

  int32_t numSpeakers() const { return num_speakers_; }
  int32_t numClasses() const { return num_classes_; }
  const std::vector<int8_t>& mapping() const { return mapping_; }

  /** Argmax over classes for each frame; writes row-major int8 labels. */
  Int8Matrix Decode(const float* logits, int32_t num_frames,
                    int32_t num_classes) const;

  /** Expected class count for given speakers / max subset size. */
  static int32_t ExpectedNumClasses(int32_t num_speakers,
                                    int32_t powerset_max_classes);

 private:
  int32_t num_speakers_ = 0;
  int32_t powerset_max_classes_ = 0;
  int32_t num_classes_ = 0;
  std::vector<int8_t> mapping_;
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_POWERSET_H
