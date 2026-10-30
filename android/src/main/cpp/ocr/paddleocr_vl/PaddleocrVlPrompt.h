/**
 * Family-owned PaddleOCR-VL chat prompt. Suffix comes from the task profile.
 */
#pragma once

#include "PaddleocrVlTaskProfile.h"

#include <stdexcept>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

inline std::string BuildPaddleocrVlPrompt(int n_placeholders,
                                         const PaddleocrVlTaskProfile& profile) {
  if (n_placeholders <= 0) {
    throw std::runtime_error("PaddleocrVlBackend: need at least one image token");
  }
  std::string prompt = "<|begin_of_sentence|>User: <|IMAGE_START|>";
  prompt.reserve(static_cast<size_t>(n_placeholders) * 22 + 80);
  for (int i = 0; i < n_placeholders; ++i) {
    prompt += "<|IMAGE_PLACEHOLDER|>";
  }
  prompt += "<|IMAGE_END|>";
  prompt += profile.prompt_suffix;
  prompt += "\nAssistant:\n";
  return prompt;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
