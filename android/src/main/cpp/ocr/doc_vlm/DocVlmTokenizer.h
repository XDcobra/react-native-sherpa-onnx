/**
 * GPT-2 byte-level BPE over tokenizer.json. No Hugging Face tokenizers runtime.
 * Encode is for the ASCII chat prompt (specials matched before BPE).
 * Decode keeps specials and concatenates byte pieces before UTF-8.
 */
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

class DocVlmTokenizer {
 public:
  DocVlmTokenizer();
  ~DocVlmTokenizer();
  DocVlmTokenizer(DocVlmTokenizer&&) noexcept;
  DocVlmTokenizer& operator=(DocVlmTokenizer&&) noexcept;
  DocVlmTokenizer(const DocVlmTokenizer&) = delete;
  DocVlmTokenizer& operator=(const DocVlmTokenizer&) = delete;

  static DocVlmTokenizer Load(const std::string& tokenizer_json_path);

  std::vector<int32_t> Encode(const std::string& text) const;
  std::string Decode(const std::vector<int32_t>& ids) const;

  /** Throws if `token` is not in the vocab. */
  int32_t TokenId(const std::string& token) const;

  bool empty() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
