#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

class PaddleocrVlTokenizer {
 public:
  PaddleocrVlTokenizer();
  ~PaddleocrVlTokenizer();
  PaddleocrVlTokenizer(PaddleocrVlTokenizer&&) noexcept;
  PaddleocrVlTokenizer& operator=(PaddleocrVlTokenizer&&) noexcept;
  PaddleocrVlTokenizer(const PaddleocrVlTokenizer&) = delete;
  PaddleocrVlTokenizer& operator=(const PaddleocrVlTokenizer&) = delete;

  static PaddleocrVlTokenizer Load(const std::string& tokenizer_json_path);

  std::vector<int32_t> Encode(const std::string& text) const;
  std::string Decode(const std::vector<int32_t>& ids) const;
  int32_t TokenId(const std::string& token) const;
  bool empty() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
