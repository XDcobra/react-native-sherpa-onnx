/**
 * Shared wav2vec2 CTC forced-alignment pipeline (preprocess, ONNX Runtime C API,
 * log-softmax, CTC backtrack, word/char intervals). Used from Android (JNI) and iOS (Objective-C++).
 *
 * Vocab-driven: blank/unk/word-delimiter and case folding are resolved from the
 * vocabulary (sidecar vocab.json, explicit JSON, or baked EN wav2vec2 defaults).
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
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

enum class CaseMode {
  kUpper,
  kLower,
  kNone,
};

struct AlignmentVocabProfile {
  std::unordered_map<std::string, int32_t> vocab;
  int32_t blankId = 0;
  int32_t unkId = 0;
  /** -1 when the vocab has no word-delimiter token (e.g. MMS FA). */
  int32_t wordDelimiterId = -1;
  CaseMode caseMode = CaseMode::kUpper;
  double frameSeconds = 0.02;
};

struct BuiltTokens {
  std::vector<int32_t> ids;
  /** Word index per id; -1 for emitted word-delimiter tokens. */
  std::vector<int32_t> wordIndex;
  std::vector<std::string> display;
};

/**
 * Resolve blank/unk/delimiter/case from vocab JSON content, sidecar vocab.json
 * next to model_path, or baked English wav2vec2-base-960h defaults.
 */
AlignmentVocabProfile ResolveVocabProfile(
    const std::string& model_path,
    const std::string& vocab_json_utf8);

/**
 * Tokenize transcript against a vocab profile. Splits on Unicode whitespace;
 * emits delimiter ids only when profile.wordDelimiterId >= 0.
 */
BuiltTokens BuildTokens(const std::string& text_utf8, const AlignmentVocabProfile& profile);

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
