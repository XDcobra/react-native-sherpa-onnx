#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "sherpa-onnx-stt-modeling-unit.h"

namespace {

std::string WriteTokens(const std::string &name, const std::string &body) {
  const std::string path = testing::TempDir() + name;
  std::ofstream(path) << body;
  return path;
}

TEST(AutoHotwordsModelingUnit, NoBpeVocabKeepsTheDefault) {
  const auto tokens = WriteTokens("cjk_tokens.txt", "<blk> 0\n\xE4\xBD\xA0 1\n");
  EXPECT_EQ(sherpaonnx::AutoHotwordsModelingUnit(tokens, ""), "");
}

TEST(AutoHotwordsModelingUnit, BpeVocabMeansBpe) {
  const auto tokens = WriteTokens("bpe_tokens.txt", "<blk> 0\n\xE2\x96\x81THE 1\nS 2\n");
  EXPECT_EQ(sherpaonnx::AutoHotwordsModelingUnit(tokens, "/m/bpe.vocab"), "bpe");
}

TEST(AutoHotwordsModelingUnit, BpeVocabWithChineseTokensMeansBoth) {
  const auto tokens =
      WriteTokens("mixed_tokens.txt", "<blk> 0\n\xE2\x96\x81THE 1\n\xE4\xBD\xA0 2\n");
  EXPECT_EQ(sherpaonnx::AutoHotwordsModelingUnit(tokens, "/m/bpe.vocab"), "cjkchar+bpe");
}

}  // namespace
