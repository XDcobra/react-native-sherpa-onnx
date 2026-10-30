#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

class NemotronParseTokenizer {
 public:
  NemotronParseTokenizer();
  ~NemotronParseTokenizer();
  NemotronParseTokenizer(NemotronParseTokenizer&&) noexcept;
  NemotronParseTokenizer& operator=(NemotronParseTokenizer&&) noexcept;
  NemotronParseTokenizer(const NemotronParseTokenizer&) = delete;
  NemotronParseTokenizer& operator=(const NemotronParseTokenizer&) = delete;

  static NemotronParseTokenizer Load(const std::string& tokenizer_json_path);

  std::vector<int32_t> Encode(const std::string& text) const;
  std::string Decode(const std::vector<int32_t>& ids) const;
  int32_t TokenId(const std::string& token) const;
  bool empty() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
