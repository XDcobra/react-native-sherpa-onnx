/**
 * Host GTests for NemotronParseBackend.
 *
 * Markup / image / npy-shape / Family always run. Tokenizer and ORT smoke run
 * when a local pack is present (NEMOTRON_PARSE_MODEL_DIR or
 * build/ocr-models/nemotron-3.5-parse/onnx-int8|onnx-fp16).
 */

#include <gtest/gtest.h>

#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "NemotronParseBackend.h"
#include "NemotronParseImageOps.h"
#include "NemotronParseMarkup.h"
#include "NemotronParseNpy.h"
#include "NemotronParseTokenizer.h"
#include "OcrTypes.h"
#include "ocr_test_image.h"

namespace fs = std::filesystem;
using namespace sherpa_onnx::ocr;
using namespace sherpa_onnx::ocr::nemotron_parse;

namespace {

const char* kUnpackHint =
    "nemotron-3.5-parse pack not found. Export locally or set "
    "NEMOTRON_PARSE_MODEL_DIR to onnx-int8 or onnx-fp16.";

std::string RepoRelativeFixture(const char* relative_from_test_fixtures) {
  const char* env = std::getenv("TEST_FIXTURES_DIR");
  if (env && env[0] != '\0') {
    std::string base = env;
    if (base.back() != '/') base += '/';
    return base + relative_from_test_fixtures;
  }
  return std::string("test/fixtures/") + relative_from_test_fixtures;
}

bool PackLooksValid(const std::string& dir) {
  if (dir.empty() || !fs::is_directory(dir)) return false;
  const fs::path root(dir);
  const char* required[] = {
      "patch_embed.onnx",
      "pos_embed.npy",
      "vision_encoder.onnx",
      "vision_encoder.onnx_data",
      "embed_tokens.onnx",
      "embed_tokens.onnx_data",
      "decoder_model_merged.onnx",
      "decoder_model_merged.onnx_data",
      "tokenizer.json",
      "ocr_manifest.json",
  };
  for (const char* file : required) {
    if (!fs::is_regular_file(root / file)) return false;
  }
  return true;
}

std::string ResolvePackDir() {
  if (const char* env = std::getenv("NEMOTRON_PARSE_MODEL_DIR")) {
    if (env[0] != '\0' && PackLooksValid(env)) return env;
  }
  const char* candidates[] = {
      "build/ocr-models/nemotron-3.5-parse/onnx-int8",
      "build/ocr-models/nemotron-3.5-parse/onnx-fp16",
      "build/ocr-models/nemotron-3.5-parse/onnx",
  };
  for (const char* candidate : candidates) {
    if (PackLooksValid(candidate)) return candidate;
  }
  return {};
}

std::string FoldAlnum(const std::string& s) {
  std::string out;
  for (unsigned char c : s) {
    if (std::isalnum(c)) out.push_back(static_cast<char>(std::tolower(c)));
  }
  return out;
}

void WriteNpyF32(const fs::path& path, const std::vector<int64_t>& shape,
                 const std::vector<float>& data) {
  std::ostringstream header;
  header << "{'descr': '<f4', 'fortran_order': False, 'shape': (";
  for (size_t i = 0; i < shape.size(); ++i) {
    if (i) header << ", ";
    header << shape[i];
  }
  if (shape.size() == 1) header << ",";
  header << "), }";
  std::string h = header.str();
  while ((10 + h.size()) % 16 != 0) h.push_back(' ');
  h.back() = '\n';
  std::ofstream out(path, std::ios::binary);
  out.write("\x93NUMPY", 6);
  const unsigned char ver[2] = {1, 0};
  out.write(reinterpret_cast<const char*>(ver), 2);
  const uint16_t len = static_cast<uint16_t>(h.size());
  out.write(reinterpret_cast<const char*>(&len), 2);
  out.write(h.data(), static_cast<std::streamsize>(h.size()));
  out.write(reinterpret_cast<const char*>(data.data()),
            static_cast<std::streamsize>(data.size() * sizeof(float)));
}

}  // namespace

TEST(NemotronParseMarkup, HelloWorld) {
  const std::string raw =
      "<x_0.0><y_0.0>Hello World<x_0.9961><y_0.9938><class_Text></s>";
  const NemotronParseMarkup parsed = ParseNemotronMarkup(raw, 100, 50, 0);
  EXPECT_EQ(parsed.markdown_utf8, "Hello World");
  EXPECT_EQ(parsed.text_utf8, "Hello World");
  EXPECT_EQ(parsed.raw_utf8.find("</s>"), std::string::npos);
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 11);
  EXPECT_NEAR(parsed.spans[0].quad.xy[0], 0.f, 0.01f);
  EXPECT_NEAR(parsed.spans[0].quad.xy[4], 99.61f, 0.2f);
}

TEST(NemotronParseMarkup, TabularBecomesGfmAndPlaintext) {
  const std::string raw =
      "<x_0.0><y_0.0>\\begin{tabular}{cc}A & B \\\\ C & D\\end{tabular}"
      "<x_1.0><y_1.0><class_Table></s>";
  const NemotronParseMarkup parsed = ParseNemotronMarkup(raw, 100, 50, 0);
  EXPECT_NE(parsed.raw_utf8.find("\\begin{tabular}"), std::string::npos);
  EXPECT_EQ(parsed.markdown_utf8,
            "| A | B |\n| --- | --- |\n| C | D |");
  EXPECT_EQ(parsed.text_utf8, "A B\nC D");
  EXPECT_EQ(parsed.markdown_utf8.find("\\begin{tabular}"), std::string::npos);
  EXPECT_EQ(parsed.text_utf8.find("\\begin"), std::string::npos);
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 7);
}

TEST(NemotronParseMarkup, ProsePlusTabularKeepsGfmHeading) {
  const std::string raw =
      "<x_0.0><y_0.0># Invoice<x_0.9><y_0.1><class_Title>"
      "<x_0.0><y_0.2>\\begin{tabular}{lrr}\n"
      "Item & Qty & Price \\\\\n"
      "\\hline\n"
      "Widget & 2 & 10 \\\\\n"
      "\\end{tabular}<x_1.0><y_0.8><class_Table></s>";
  const NemotronParseMarkup parsed = ParseNemotronMarkup(raw, 200, 200, 0);
  EXPECT_EQ(parsed.markdown_utf8,
            "# Invoice\n| Item | Qty | Price |\n| --- | --- | --- |\n| Widget | 2 | "
            "10 |");
  EXPECT_EQ(parsed.text_utf8, "# Invoice\nItem Qty Price\nWidget 2 10");
  ASSERT_EQ(parsed.spans.size(), 2u);
  EXPECT_EQ(parsed.spans[0].utf16_end, 9);
  EXPECT_EQ(parsed.spans[1].utf16_start, 10);
}

TEST(NemotronParseMarkup, EmptyPictureStillEmitsSpan) {
  const std::string raw =
      "<x_0.2><y_0.3><x_0.8><y_0.7><class_Picture></s>";
  const NemotronParseMarkup parsed = ParseNemotronMarkup(raw, 100, 50, 0);
  EXPECT_EQ(parsed.markdown_utf8, "");
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 0);
}

TEST(NemotronParseImageOps, EnHelloPatchStats) {
  const std::string image_path = RepoRelativeFixture("ocr/en_hello.png");
  if (!fs::is_regular_file(image_path)) GTEST_SKIP() << image_path;
  const ocr_test::RgbImage image = ocr_test::LoadRgbImage(image_path);
  const NemotronParsePatches page = PreprocessRgb(image.rgb.data(), image.width, image.height);
  EXPECT_EQ(page.content_h, 240);
  EXPECT_EQ(page.content_w, 1000);
  EXPECT_EQ(page.image_h, 240);
  EXPECT_EQ(page.image_w, 1024);
  EXPECT_EQ(page.rows * page.cols, 960);
  ASSERT_GE(page.patches.size(), 8u);
  EXPECT_NEAR(page.patches[0], 1.930336f, 1e-4f);
  double sum = 0.0;
  for (float v : page.patches) sum += v;
  EXPECT_NEAR(sum / static_cast<double>(page.patches.size()), 1.918, 0.02);
}

TEST(NemotronParseImageOps, SmallWhitePage) {
  const int w = 32;
  const int h = 24;
  std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3, 255);
  const NemotronParsePatches page = PreprocessRgb(rgb.data(), w, h);
  EXPECT_EQ(page.content_w, 32);
  EXPECT_EQ(page.content_h, 24);
  EXPECT_EQ(page.image_h % 16, 0);
  EXPECT_EQ(page.image_w % 64, 0);
  EXPECT_EQ(page.rows * page.cols * 768, static_cast<int>(page.patches.size()));
}

TEST(NemotronParseNpy, RejectsBadShape) {
  const fs::path path = fs::temp_directory_path() / "nemotron_bad_pos.npy";
  WriteNpyF32(path, {2, 2}, {1.f, 2.f, 3.f, 4.f});
  EXPECT_THROW(LoadPosEmbedNpy(path.string()), std::runtime_error);
  fs::remove(path);
}

TEST(NemotronParseBackend, Family) {
  NemotronParseBackend backend;
  EXPECT_STREQ(backend.Family(), "nemotron_parse");
}

TEST(NemotronParseTokenizer, ControlPrompt) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = NemotronParseTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  const auto ids = tok.Encode(
      "</s><s><predict_bbox><predict_classes><output_markdown><predict_text_in_pic>");
  ASSERT_EQ(ids.size(), 6u);
  EXPECT_EQ(ids[0], 2);
  EXPECT_EQ(ids[1], 0);
  EXPECT_EQ(tok.TokenId("<predict_bbox>"), 50004);
  EXPECT_EQ(tok.TokenId("<output_markdown>"), 50001);
  EXPECT_NE(tok.Decode(ids).find("<predict_bbox>"), std::string::npos);
}

TEST(NemotronParseTokenizer, AsciiRoundTrip) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = NemotronParseTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  const std::string text = "Hello World";
  const auto ids = tok.Encode(text);
  ASSERT_FALSE(ids.empty());
  const std::string back = tok.Decode(ids);
  EXPECT_NE(FoldAlnum(back).find("helloworld"), std::string::npos) << back;
}

TEST(NemotronParseTokenizer, DecodeMarkupSpecials) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = NemotronParseTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  const auto hi = tok.Encode("Hi");
  ASSERT_FALSE(hi.empty());
  std::vector<int32_t> ids = {
      tok.TokenId("<x_0.0>"),
  };
  ids.insert(ids.end(), hi.begin(), hi.end());
  ids.push_back(tok.TokenId("<x_0.9961>"));
  ids.push_back(tok.TokenId("<y_0.9938>"));
  ids.push_back(tok.TokenId("<class_Text>"));
  const std::string back = tok.Decode(ids);
  EXPECT_NE(back.find("<x_0.0>"), std::string::npos) << back;
  EXPECT_NE(back.find("Hi"), std::string::npos) << back;
  EXPECT_NE(back.find("<x_0.9961>"), std::string::npos) << back;
  EXPECT_NE(back.find("<y_0.9938>"), std::string::npos) << back;
  EXPECT_NE(back.find("<class_Text>"), std::string::npos) << back;
}

TEST(NemotronParseNpy, LoadsPackTable) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto table = LoadPosEmbedNpy((fs::path(dir) / "pos_embed.npy").string());
  EXPECT_EQ(table.size(), 16384u * 1152u);
  bool finite = true;
  for (size_t i = 0; i < table.size(); i += 1024) {
    if (!std::isfinite(table[i])) finite = false;
  }
  EXPECT_TRUE(finite);
}

TEST(NemotronParseSmoke, EnHello) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const std::string image_path = RepoRelativeFixture("ocr/en_hello.png");
  if (!fs::is_regular_file(image_path)) {
    GTEST_SKIP() << "missing fixture " << image_path;
  }
  const ocr_test::RgbImage image = ocr_test::LoadRgbImage(image_path);

  OcrLoadOptions options;
  options.num_threads = 2;
  options.max_new_tokens = 64;

  NemotronParseBackend backend;
  backend.Load(dir, options);
  OcrFrameView frame;
  frame.rgb = image.rgb.data();
  frame.width = image.width;
  frame.height = image.height;
  const OcrResult result = backend.Recognize(frame);
  std::fprintf(stderr, "[SherpaOnnx:ocr] nemotron_parse smoke raw=%s\n",
               result.raw_utf8.c_str());
  EXPECT_FALSE(result.raw_utf8.empty());
  EXPECT_TRUE(result.doctags_utf8.empty());
  EXPECT_NE(result.raw_utf8.find("<x_"), std::string::npos);
  EXPECT_NE(FoldAlnum(result.text_utf8).find("hello"), std::string::npos) << result.text_utf8;
  EXPECT_FALSE(result.markdown_utf8.empty());
  EXPECT_TRUE(result.stop_reason == "eos" || result.stop_reason == "max_new_tokens");
  ASSERT_GE(result.spans.size(), 1u);
  for (const OcrSpan& span : result.spans) {
    EXPECT_EQ(span.level, OcrSpanLevel::kLine);
    for (float xy : span.quad.xy) EXPECT_TRUE(std::isfinite(xy));
  }
}
