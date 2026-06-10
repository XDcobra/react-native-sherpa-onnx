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

struct ForcedCtcToken {
  std::string text;
  double start_ms = 0.0;
  double end_ms = 0.0;
};

struct ForcedCtcDiagnostics {
  double ctc_blank_ratio = 0.0;
  int32_t frames_processed = 0;
};

struct ForcedCtcResult {
  std::vector<ForcedCtcToken> tokens;
  int32_t consumed_token_count = 0;
  ForcedCtcDiagnostics diagnostics;
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

ForcedCtcResult AlignAccurateForcedCtcFromPcm(
  const std::string& model_path,
  const std::string& window_text,
  const float* samples,
  size_t sample_count,
  int32_t sample_rate,
  const std::string& granularity,
  const std::string& language = ""
);

}  // namespace alignment
}  // namespace sherpa_onnx
