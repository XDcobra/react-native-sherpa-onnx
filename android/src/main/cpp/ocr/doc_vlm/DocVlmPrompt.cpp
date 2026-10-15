#include "DocVlmPrompt.h"

#include <stdexcept>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

constexpr int kImageSeqLen = 64;
constexpr char kUserText[] = "Convert this page to docling.";

void AppendImages(std::string& text) {
  for (int i = 0; i < kImageSeqLen; ++i) text += "<image>";
}

std::string BuildPromptText(int rows, int cols) {
  std::string text = "<|start_of_role|>user<|end_of_role|>";
  if (rows == 0 && cols == 0) {
    text += "<fake_token_around_image><global-img>";
    AppendImages(text);
    text += "<fake_token_around_image>";
  } else {
    for (int r = 1; r <= rows; ++r) {
      for (int c = 1; c <= cols; ++c) {
        text += "<fake_token_around_image><row_";
        text += std::to_string(r);
        text += "_col_";
        text += std::to_string(c);
        text += ">";
        AppendImages(text);
      }
      text += "\n";
    }
    text += "\n<fake_token_around_image><global-img>";
    AppendImages(text);
    text += "<fake_token_around_image>";
  }
  text += kUserText;
  text += "<|end_of_text|>\n<|start_of_role|>assistant<|end_of_role|>";
  return text;
}

}  // namespace

std::vector<int32_t> BuildPromptIds(const DocVlmTokenizer& tokenizer, int rows, int cols) {
  const bool single = rows == 0 && cols == 0;
  const bool split = rows >= 1 && cols >= 1;
  if (!single && !split) {
    throw std::invalid_argument("DocVlmPrompt: rows and cols must both be 0 or both be >= 1");
  }
  if (rows > 4 || cols > 4) {
    throw std::invalid_argument("DocVlmPrompt: rows and cols must be <= 4");
  }
  // Encode the expanded chat string so adjacent newlines follow BPE
  // (this pack merges "\n\n" to ĊĊ, id 271) instead of two separate newline ids.
  return tokenizer.Encode(BuildPromptText(rows, cols));
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
