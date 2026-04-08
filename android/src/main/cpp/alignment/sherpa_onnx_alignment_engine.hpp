/**
 * Shared alignment engine for proportional / estimated / accurate subtitle timing.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace alignment {

struct SubtitleItem {
  std::string text;
  double start_s = 0.0;
  double end_s = 0.0;
};

struct AlignmentResult {
  std::vector<SubtitleItem> subtitles;
  std::string timing_mode;
};

AlignmentResult AlignProportional(
    const std::string& text,
    int32_t total_samples,
    int32_t sample_rate,
    const std::string& granularity  // sentence | word
);

AlignmentResult AlignEstimated(
    const std::string& text,
    const std::vector<int32_t>& segment_sample_counts,
    int32_t sample_rate,
    const std::string& granularity  // sentence | word
);

AlignmentResult AlignAccurateFromPcm(
    const std::string& model_path,
    const std::string& text,
    const float* samples,
    size_t sample_count,
    int32_t sample_rate,
    const std::string& granularity  // sentence | word | character
);

AlignmentResult AlignAccurateFromFile(
    const std::string& model_path,
    const std::string& text,
    const std::string& audio_path,
    const std::string& granularity  // sentence | word | character
);

}  // namespace alignment
}  // namespace sherpa_onnx
