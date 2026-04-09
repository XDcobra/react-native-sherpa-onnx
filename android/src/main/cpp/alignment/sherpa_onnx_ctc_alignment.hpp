/**
 * Shared wav2vec2 CTC forced-alignment pipeline (preprocess, ONNX Runtime C API,
 * log-softmax, CTC backtrack, word/char intervals). Used from Android (JNI) and iOS (Objective-C++).
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ctc_alignment {

struct AlignmentInterval {
  std::string text;
  double start_s = 0.0;
  double end_s = 0.0;
};

struct CtcAlignmentResult {
  std::vector<AlignmentInterval> words;
  std::vector<AlignmentInterval> chars;
};

/**
 * Mono float PCM at source_sample_rate Hz → 16 kHz → normalize → ORT → CTC → timings.
 * @throws std::runtime_error (or other std::exception) on failure.
 */
CtcAlignmentResult RunCtcAlignmentFromFloatPcm(
    const std::string& model_path,
    const std::string& text_utf8,
    const std::string& vocab_json_utf8,
    const float* samples,
    size_t sample_count,
    int32_t source_sample_rate);

}  // namespace ctc_alignment
}  // namespace sherpa_onnx
