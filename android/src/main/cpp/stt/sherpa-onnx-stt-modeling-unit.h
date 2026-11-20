#pragma once

#include <fstream>
#include <string>

namespace sherpaonnx {

/**
 * The hotwords modeling unit to use when the caller gave none: "bpe" when the model has a BPE
 * vocabulary, "cjkchar+bpe" when its tokens also hold CJK characters, and "" (sherpa-onnx's
 * default "cjkchar") without a BPE vocabulary.
 */
inline std::string AutoHotwordsModelingUnit(const std::string &tokensPath,
                                            const std::string &bpeVocab) {
  if (bpeVocab.empty()) return "";
  std::ifstream in(tokensPath);
  std::string line;
  while (std::getline(in, line)) {
    // A token line is "<token> <id>"; CJK Unified Ideographs (U+4E00..U+9FFF) start with
    // UTF-8 lead bytes 0xE4..0xE9.
    const auto lead = static_cast<unsigned char>(line.empty() ? 0 : line[0]);
    if (lead >= 0xE4 && lead <= 0xE9) return "cjkchar+bpe";
  }
  return "bpe";
}

}  // namespace sherpaonnx
