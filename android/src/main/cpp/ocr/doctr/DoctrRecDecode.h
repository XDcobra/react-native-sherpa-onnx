/**
 * Recognition decoder for doctr/OnnxTR.
 *
 * CRNN (CTC): blank index = C-1 (last class), NOT 0.
 * PARSeq:     argmax-until-EOS, EOS = last index.
 */
#pragma once

#include <string>
#include <utility>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doctr {

/**
 * CTC greedy decode with blank at LAST index (C-1).
 * logits: [T, C] row-major.
 * vocab[i] maps class index i to a UTF-8 codepoint string.
 * Returns (utf8_text, mean_confidence).
 */
std::pair<std::string, float> CtcBlankLastDecode(
    const float* logits,
    int time_steps,
    int num_classes,
    const std::vector<std::string>& vocab);

/**
 * PARSeq / ViTSTR argmax decode: stop at EOS (last index = C-1).
 * logits: [T, C] row-major.
 * vocab[i] maps class index i to a UTF-8 codepoint string.
 * Returns (utf8_text, mean_confidence).
 */
std::pair<std::string, float> ParseqDecode(
    const float* logits,
    int time_steps,
    int num_classes,
    const std::vector<std::string>& vocab);

/** UTF-8 → UTF-16 code unit count (BMP + surrogate pairs). */
int Utf8ToUtf16Length(const std::string& utf8);

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
