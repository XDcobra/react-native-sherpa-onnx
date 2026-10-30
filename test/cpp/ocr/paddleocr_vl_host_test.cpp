/**
 * Host GTests for PaddleocrVlBackend.
 *
 * Markup / smart_resize / rope / Family always run. Tokenizer and ORT smoke
 * run when a local pack is present (PADDLEOCR_VL_MODEL_DIR or
 * build/ocr-models/paddleocr-vl-1.6/onnx-fp16).
 */

#include <gtest/gtest.h>

#include <onnxruntime_cxx_api.h>

#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

#include "OcrOrtEnv.h"
#include "OcrOrtHelpers.h"
#include "OcrTypes.h"
#include "ocr_elements_json.h"
#include "PaddleocrVlBackend.h"
#include "PaddleocrVlImageOps.h"
#include "PaddleocrVlMarkup.h"
#include "PaddleocrVlPrompt.h"
#include "PaddleocrVlRope.h"
#include "PaddleocrVlTaskProfile.h"
#include "PaddleocrVlTokenizer.h"
#include "ocr_test_image.h"

#include <fstream>
#include <iterator>

namespace fs = std::filesystem;
using namespace sherpa_onnx::ocr;
using namespace sherpa_onnx::ocr::paddleocr_vl;

namespace {

const char* kUnpackHint =
    "paddleocr-vl pack not found. Export locally or set "
    "PADDLEOCR_VL_MODEL_DIR to onnx-fp16 or onnx/.";

bool PackLooksValid(const std::string& dir) {
  if (dir.empty() || !fs::is_directory(dir)) return false;
  const fs::path root(dir);
  const char* required[] = {
      "vision_encoder.onnx",
      "vision_encoder.onnx_data",
      "embedding.onnx",
      "embedding.onnx_data",
      "decoder.onnx",
      "decoder.onnx_data",
      "tokenizer.json",
      "ocr_manifest.json",
  };
  for (const char* file : required) {
    if (!fs::is_regular_file(root / file)) return false;
  }
  return true;
}

std::string ResolvePackDir() {
  if (const char* env = std::getenv("PADDLEOCR_VL_MODEL_DIR")) {
    if (env[0] != '\0' && PackLooksValid(env)) return env;
  }
  const char* candidates[] = {
      "build/ocr-models/paddleocr-vl-1.6/onnx-fp16",
      "build/ocr-models/paddleocr-vl-1.6/onnx",
  };
  for (const char* candidate : candidates) {
    if (PackLooksValid(candidate)) return candidate;
  }
  return {};
}

std::string TokenizerDirOrEmpty() {
  const std::string pack = ResolvePackDir();
  if (!pack.empty()) return pack;
  const char* candidates[] = {
      "example/.model-cache/paddleocr-vl-1.6-fp16",
      "build/ocr-models/paddleocr-vl-1.6/onnx-fp16",
      "build/ocr-models/paddleocr-vl-1.6/hf-src",
  };
  for (const char* candidate : candidates) {
    if (fs::is_regular_file(fs::path(candidate) / "tokenizer.json")) {
      return candidate;
    }
  }
  return {};
}

std::string RepoRelativeFixture(const char* relative_from_test_fixtures) {
  const char* env = std::getenv("TEST_FIXTURES_DIR");
  if (env && env[0] != '\0') {
    std::string base = env;
    if (base.back() != '/') base += '/';
    return base + relative_from_test_fixtures;
  }
  return std::string("test/fixtures/") + relative_from_test_fixtures;
}

std::string ReadWholeFile(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("missing fixture: " + path);
  return std::string((std::istreambuf_iterator<char>(in)),
                     std::istreambuf_iterator<char>());
}

std::vector<int32_t> ParseIntArrayJson(const std::string& json) {
  std::vector<int32_t> ids;
  size_t i = 0;
  while (i < json.size() && json[i] != '[') ++i;
  if (i >= json.size()) throw std::runtime_error("prompt_ids.json is not an array");
  ++i;
  while (i < json.size()) {
    while (i < json.size() && (json[i] == ' ' || json[i] == '\n' || json[i] == '\t' ||
                               json[i] == '\r' || json[i] == ',')) {
      ++i;
    }
    if (i < json.size() && json[i] == ']') break;
    if (i >= json.size()) break;
    char* end = nullptr;
    const long value = std::strtol(json.c_str() + i, &end, 10);
    if (end == json.c_str() + i) {
      throw std::runtime_error("prompt_ids.json has a non-integer");
    }
    ids.push_back(static_cast<int32_t>(value));
    i = static_cast<size_t>(end - json.c_str());
  }
  return ids;
}

int CountId(const std::vector<int32_t>& ids, int32_t want) {
  int n = 0;
  for (int32_t id : ids) {
    if (id == want) ++n;
  }
  return n;
}

}  // namespace

TEST(OcrCreateOrtSession, MissingOnnxThrowsRuntimeError) {
  Ort::Env& env = SharedOrtEnv();
  Ort::SessionOptions opts = OcrMakeVlmSessionOptions(1, "cpu");
  EXPECT_THROW(
      {
        auto session = OcrCreateOrtSession(env, opts, "/no/such/ocr-session.onnx",
                                           "missing", "cpu");
        (void)session;
      },
      std::runtime_error);
}

TEST(PaddleocrVlMarkup, TableOtslToGfm) {
  PaddleocrVlParseOptions opt;
  opt.task = "table";
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(
      "<fcel>Item<fcel>Qty<nl><fcel>Bolts<fcel>120</s>", opt);
  EXPECT_EQ(parsed.markdown_utf8, "| Item | Qty |\n| --- | --- |\n| Bolts | 120 |");
  EXPECT_EQ(parsed.text_utf8, "Item | Qty\nBolts | 120");
  EXPECT_TRUE(parsed.elements.empty());
}

TEST(PaddleocrVlMarkup, FormulaPassthroughLatex) {
  PaddleocrVlParseOptions opt;
  opt.task = "formula";
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup("\\[E=mc^2\\]</s>", opt);
  EXPECT_EQ(parsed.markdown_utf8, "\\[E=mc^2\\]");
  EXPECT_TRUE(parsed.elements.empty());
}

TEST(PaddleocrVlMarkup, ChartGfmPipes) {
  PaddleocrVlParseOptions opt;
  opt.task = "chart";
  const PaddleocrVlMarkup parsed =
      ParsePaddleocrVlMarkup("Month | Units\nMon | 12\nTue | 18</s>", opt);
  EXPECT_EQ(parsed.markdown_utf8,
            "| Month | Units |\n| --- | --- |\n| Mon | 12 |\n| Tue | 18 |");
  EXPECT_TRUE(parsed.elements.empty());
}

TEST(PaddleocrVlMarkup, SealPlain) {
  PaddleocrVlParseOptions opt;
  opt.task = "seal";
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup("CITY HALL\nSEAL 01</s>", opt);
  EXPECT_EQ(parsed.markdown_utf8, "CITY HALL\nSEAL 01");
  EXPECT_TRUE(parsed.elements.empty());
}

TEST(PaddleocrVlMarkup, HelloWorld) {
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup("Hello World</s>");
  EXPECT_EQ(parsed.raw_utf8, "Hello World");
  EXPECT_EQ(parsed.markdown_utf8, "Hello World");
  EXPECT_EQ(parsed.text_utf8, "Hello World");
  EXPECT_TRUE(parsed.spans.empty());
  EXPECT_EQ(ocr_test::ElementsToJson(parsed.elements),
            ocr_test::ReadElementsGolden("paddle_ocr_hello.json"));
}

TEST(PaddleocrVlMarkup, StripsHtmlAndMarkdownTicks) {
  const PaddleocrVlMarkup parsed =
      ParsePaddleocrVlMarkup("# Title\n<p>Hello</p> **World**");
  EXPECT_EQ(parsed.text_utf8, "Title Hello World");
  EXPECT_TRUE(parsed.spans.empty());
}

namespace {

std::string LocToken(int n) {
  return "<|LOC_" + std::to_string(n) + "|>";
}

std::string EightLoc(int x1, int y1, int x2, int y2, int x3, int y3, int x4,
                     int y4) {
  return LocToken(x1) + LocToken(y1) + LocToken(x2) + LocToken(y2) +
         LocToken(x3) + LocToken(y3) + LocToken(x4) + LocToken(y4);
}

}  // namespace

TEST(PaddleocrVlMarkup, OcrTaskIgnoresLocTokens) {
  const std::string raw = "Hi" + EightLoc(0, 0, 1000, 0, 1000, 1000, 0, 1000);
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(raw);
  EXPECT_EQ(parsed.raw_utf8, raw);
  EXPECT_EQ(parsed.markdown_utf8, "Hi");
  EXPECT_TRUE(parsed.spans.empty());
}

TEST(PaddleocrVlMarkup, SpottingParsesQuadOnKnownFrame) {
  const std::string raw = "Hi" + EightLoc(0, 0, 1000, 0, 1000, 1000, 0, 1000);
  PaddleocrVlParseOptions opt;
  opt.task = "spotting";
  opt.frame_width = 200;
  opt.frame_height = 100;
  opt.frame_index = 2;
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(raw, opt);
  EXPECT_EQ(parsed.raw_utf8, raw);
  EXPECT_EQ(parsed.text_utf8, "Hi");
  EXPECT_EQ(parsed.markdown_utf8, "Hi");
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 2);
  EXPECT_EQ(parsed.spans[0].frame_index, 2);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
  EXPECT_FLOAT_EQ(parsed.spans[0].confidence, 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[0], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[1], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[2], 200.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[3], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[4], 200.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[5], 100.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[6], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[7], 100.f);
}

TEST(PaddleocrVlMarkup, SpottingJoinsInstancesAndKeepsLocInRaw) {
  const std::string raw = "Hello" + EightLoc(0, 0, 100, 0, 100, 100, 0, 100) +
                          "\nWorld" +
                          EightLoc(10, 20, 30, 20, 30, 40, 10, 40);
  PaddleocrVlParseOptions opt;
  opt.task = "spotting";
  opt.frame_width = 1000;
  opt.frame_height = 1000;
  const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(raw, opt);
  EXPECT_EQ(parsed.raw_utf8, raw);
  EXPECT_NE(parsed.raw_utf8.find("<|LOC_"), std::string::npos);
  EXPECT_EQ(parsed.text_utf8, "Hello\nWorld");
  ASSERT_EQ(parsed.spans.size(), 2u);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 5);
  EXPECT_EQ(parsed.spans[1].utf16_start, 6);
  EXPECT_EQ(parsed.spans[1].utf16_end, 11);
  EXPECT_FLOAT_EQ(parsed.spans[1].quad.xy[0], 10.f);
  EXPECT_FLOAT_EQ(parsed.spans[1].quad.xy[1], 20.f);
}

TEST(PaddleocrVlImageOps, EffectiveMaxPixelsCapsTaskDefault) {
  EXPECT_EQ(EffectiveMaxPixels(0, kOfficialMaxPixels), kOfficialMaxPixels);
  EXPECT_EQ(EffectiveMaxPixels(0, kSpottingMaxPixels), kSpottingMaxPixels);
  EXPECT_EQ(EffectiveMaxPixels(kMobileMaxPixels, kSpottingMaxPixels),
            kMobileMaxPixels);
  EXPECT_EQ(EffectiveMaxPixels(kSpottingMaxPixels, kOfficialMaxPixels),
            kOfficialMaxPixels);
}

TEST(PaddleocrVlImageOps, SpottingUpscalesWhenBothSidesSmall) {
  const int w = 80;
  const int h = 60;
  std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3, 128);
  PaddleocrVlPreprocessOptions opt;
  opt.task_max_pixels = kSpottingMaxPixels;
  opt.upscale_small_2x = true;
  const PaddleocrVlPatches page = PreprocessRgb(rgb.data(), w, h, opt);
  EXPECT_TRUE(page.upscaled);
  EXPECT_EQ(page.effective_max_pixels, kSpottingMaxPixels);
  EXPECT_EQ(page.src_w, w);
  EXPECT_EQ(page.src_h, h);
}

TEST(PaddleocrVlImageOps, OcrDoesNotUpscale) {
  const int w = 80;
  const int h = 60;
  std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3, 128);
  PaddleocrVlPreprocessOptions opt;
  opt.task_max_pixels = kOfficialMaxPixels;
  opt.upscale_small_2x = false;
  const PaddleocrVlPatches page = PreprocessRgb(rgb.data(), w, h, opt);
  EXPECT_FALSE(page.upscaled);
  EXPECT_EQ(page.effective_max_pixels, kOfficialMaxPixels);
}

TEST(PaddleocrVlImageOps, SmartResizeTinyPage) {
  const SmartResizeSize size = SmartResize(24, 32);
  EXPECT_EQ(size.height % 28, 0);
  EXPECT_EQ(size.width % 28, 0);
  EXPECT_GE(size.height * size.width, 112896);
  EXPECT_LE(size.height * size.width, 1003520);
}

TEST(PaddleocrVlImageOps, MobileMaxPixelsCapsLargePage) {
  const int w = 2000;
  const int h = 2000;
  std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3, 128);
  const PaddleocrVlPatches page = PreprocessRgb(rgb.data(), w, h, kMobileMaxPixels);
  EXPECT_EQ(page.src_w, w);
  EXPECT_EQ(page.src_h, h);
  EXPECT_LE(page.resized_h * page.resized_w, kMobileMaxPixels);
  EXPECT_GE(page.resized_h * page.resized_w, kMinPixels);
  EXPECT_EQ(page.resized_h % 28, 0);
  EXPECT_EQ(page.resized_w % 28, 0);
}

TEST(PaddleocrVlImageOps, SmallWhitePageUnfold) {
  const int w = 32;
  const int h = 24;
  std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3, 255);
  const PaddleocrVlPatches page = PreprocessRgb(rgb.data(), w, h);
  EXPECT_EQ(page.src_w, w);
  EXPECT_EQ(page.src_h, h);
  EXPECT_EQ(page.resized_h % 28, 0);
  EXPECT_EQ(page.resized_w % 28, 0);
  EXPECT_EQ(page.grid_t, 1);
  EXPECT_EQ(page.grid_h, page.resized_h / 14);
  EXPECT_EQ(page.grid_w, page.resized_w / 14);
  EXPECT_EQ(page.num_patches, page.grid_h * page.grid_w);
  EXPECT_EQ(page.pixel_values.size(),
            static_cast<size_t>(page.num_patches) * 3 * 14 * 14);
}

TEST(PaddleocrVlRope, ImageBlockIndices) {
  // 4 text tokens, 4 image tokens (grid 1,4,2 merge 2 → 1*2*1=2 wait).
  // grid t=1,h=4,w=2, merge=2 → llm 1 x 2 x 1 = 2 vision tokens.
  std::vector<int64_t> ids = {1, 10, 100295, 100295, 20, 30};
  const RopeIndex rope = ComputeRopeIndex(ids, 1, 4, 2, 100295, 2);
  ASSERT_EQ(rope.seq, 6);
  ASSERT_EQ(rope.position_ids.size(), 18u);
  // text prefix length 2 at st_idx 0 → positions 0,1 then vision (t=2, h=2+hh, w=2+ww)
  EXPECT_EQ(rope.position_ids[0], 0);
  EXPECT_EQ(rope.position_ids[1], 1);
  EXPECT_EQ(rope.position_ids[2], 2);  // t plane, first vision
  EXPECT_GE(rope.position_ids[4], 0);  // remaining text
}

TEST(PaddleocrVlPrompt, TaskIdsMatchGoldens) {
  const std::string dir = TokenizerDirOrEmpty();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok =
      PaddleocrVlTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  struct Case {
    PaddleocrVlTask task;
    const char* rel;
  };
  const Case cases[] = {
      {PaddleocrVlTask::kOcr, "ocr/instructions/paddleocr_vl/ocr/page_01/prompt_ids.json"},
      {PaddleocrVlTask::kTable,
       "ocr/instructions/paddleocr_vl/table/table_01/prompt_ids.json"},
      {PaddleocrVlTask::kFormula,
       "ocr/instructions/paddleocr_vl/formula/formula_01/prompt_ids.json"},
      {PaddleocrVlTask::kChart,
       "ocr/instructions/paddleocr_vl/chart/chart_01/prompt_ids.json"},
      {PaddleocrVlTask::kSeal, "ocr/instructions/paddleocr_vl/seal/seal_01/prompt_ids.json"},
      {PaddleocrVlTask::kSpotting,
       "ocr/instructions/paddleocr_vl/spotting/spotting_01/prompt_ids.json"},
  };
  constexpr int32_t kImagePlaceholder = 100295;
  for (const auto& c : cases) {
    const auto golden =
        ParseIntArrayJson(ReadWholeFile(RepoRelativeFixture(c.rel)));
    const int n = CountId(golden, kImagePlaceholder);
    ASSERT_GT(n, 0) << c.rel;
    const auto ids = tok.Encode(BuildPaddleocrVlPrompt(n, ProfileFor(c.task)));
    EXPECT_EQ(ids, golden) << c.rel;
  }
}

TEST(PaddleocrVlBackend, Family) {
  PaddleocrVlBackend backend;
  EXPECT_STREQ(backend.Family(), "paddleocr_vl");
}

TEST(PaddleocrVlTokenizer, ControlPrompt) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = PaddleocrVlTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  EXPECT_EQ(tok.TokenId("<|IMAGE_PLACEHOLDER|>"), 100295);
  EXPECT_EQ(tok.TokenId("<|IMAGE_START|>"), 101305);
  EXPECT_EQ(tok.TokenId("<|IMAGE_END|>"), 101306);
  EXPECT_EQ(tok.TokenId("<|begin_of_sentence|>"), 100273);
  EXPECT_EQ(tok.TokenId("</s>"), 2);
  const auto ids = tok.Encode(
      "<|begin_of_sentence|>User: <|IMAGE_START|><|IMAGE_PLACEHOLDER|><|IMAGE_END|>OCR:\n"
      "Assistant:\n");
  ASSERT_GE(ids.size(), 5u);
  EXPECT_EQ(ids[0], 100273);
  bool saw_image = false;
  for (int32_t id : ids) {
    if (id == 100295) saw_image = true;
  }
  EXPECT_TRUE(saw_image);
  EXPECT_EQ(ids[0], tok.Encode("<|begin_of_sentence|>")[0]);
}

TEST(PaddleocrVlTokenizer, LocTokenRoundTrip) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = PaddleocrVlTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  const int32_t loc0 = tok.TokenId("<|LOC_0|>");
  const int32_t loc1000 = tok.TokenId("<|LOC_1000|>");
  ASSERT_GE(loc0, 0);
  ASSERT_GE(loc1000, 0);
  const std::string decoded = tok.Decode({loc0, loc1000});
  EXPECT_NE(decoded.find("<|LOC_0|>"), std::string::npos);
  EXPECT_NE(decoded.find("<|LOC_1000|>"), std::string::npos);
}

TEST(PaddleocrVlTokenizer, SpottingPromptEncodes) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = PaddleocrVlTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  const auto ids = tok.Encode(
      "<|begin_of_sentence|>User: <|IMAGE_START|><|IMAGE_PLACEHOLDER|><|IMAGE_END|>Spotting:\n"
      "Assistant:\n");
  ASSERT_GE(ids.size(), 5u);
  EXPECT_EQ(ids[0], 100273);
}

TEST(PaddleocrVlTokenizer, AsciiRoundTrip) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const auto tok = PaddleocrVlTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  const std::string text = "Hello World";
  const auto ids = tok.Encode(text);
  ASSERT_FALSE(ids.empty());
  const std::string decoded = tok.Decode(ids);
  EXPECT_NE(decoded.find("Hello"), std::string::npos);
  EXPECT_NE(decoded.find("World"), std::string::npos);
}

TEST(PaddleocrVlMarkup, InstructionGoldenRawsParse) {
  struct Case {
    const char* task;
    const char* fixture;
    const char* needle;
  };
  const Case cases[] = {
      {"ocr", "ocr/page_01", "Quarterly"},
      {"ocr", "ocr/page_02", nullptr},
      {"ocr", "ocr/page_03", nullptr},
      {"table", "table/table_01", "| Item |"},
      {"table", "table/table_02", "|"},
      {"table", "table/table_03", "|"},
      {"formula", "formula/formula_01", "\\["},
      {"formula", "formula/formula_02", "\\["},
      {"formula", "formula/formula_03", "\\["},
      {"chart", "chart/chart_01", "| Month |"},
      {"chart", "chart/chart_02", "|"},
      {"chart", "chart/chart_03", "|"},
      {"seal", "seal/seal_01", "CITY HALL"},
      {"seal", "seal/seal_02", nullptr},
      {"seal", "seal/seal_03", nullptr},
  };
  for (const auto& c : cases) {
    const std::string rel =
        std::string("ocr/instructions/paddleocr_vl/") + c.fixture + "/raw.txt";
    const std::string raw = ReadWholeFile(RepoRelativeFixture(rel.c_str()));
    PaddleocrVlParseOptions opt;
    opt.task = c.task;
    const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(raw, opt);
    const auto& profile = ProfileForId(c.task);
    EXPECT_TRUE(parsed.elements.empty()) << c.fixture;
    EXPECT_TRUE(parsed.spans.empty()) << c.fixture;
    EXPECT_FALSE(parsed.markdown_utf8.empty()) << c.fixture;
    EXPECT_FALSE(parsed.text_utf8.empty()) << c.fixture;
    OcrResult result;
    SetOcrContent(result, profile.content_format, parsed.markdown_utf8);
    EXPECT_EQ(result.content.format, profile.content_format) << c.fixture;
    if (c.needle != nullptr) {
      EXPECT_NE(parsed.markdown_utf8.find(c.needle), std::string::npos)
          << c.fixture << " markdown=" << parsed.markdown_utf8;
    }
    if (profile.parser == PaddleocrVlParser::kOtsl ||
        profile.parser == PaddleocrVlParser::kGfmTable) {
      EXPECT_NE(parsed.markdown_utf8.find("| --- |"), std::string::npos)
          << c.fixture;
    }
  }
}

TEST(PaddleocrVlMarkup, InstructionSpottingGoldenRawsParseAndIdentity) {
  struct Case {
    const char* id;
    const char* needle;
  };
  const Case cases[] = {
      {"spotting_01", "Hello World"},
      {"spotting_02", "Lot 44"},
      {"spotting_03", "Alpha"},
  };
  int identical = 0;
  for (const auto& c : cases) {
    const std::string dir =
        std::string("ocr/instructions/paddleocr_vl/spotting/") + c.id;
    const std::string meta_path =
        RepoRelativeFixture((dir + "/meta.json").c_str());
    const std::string raw_path = RepoRelativeFixture((dir + "/raw.txt").c_str());
    if (!fs::is_regular_file(meta_path) || !fs::is_regular_file(raw_path)) {
      GTEST_SKIP() << "instruction spotting golden missing: " << dir;
    }
  }
  for (const auto& c : cases) {
    const std::string dir =
        std::string("ocr/instructions/paddleocr_vl/spotting/") + c.id;
    const std::string meta_path =
        RepoRelativeFixture((dir + "/meta.json").c_str());
    const std::string raw_path = RepoRelativeFixture((dir + "/raw.txt").c_str());
    const std::string meta = ReadWholeFile(meta_path);
    const bool meta_identical =
        meta.find("\"token_identical\": true") != std::string::npos;
    EXPECT_TRUE(meta_identical) << c.id;
    if (meta_identical) ++identical;
    EXPECT_NE(meta.find("\"upscaled\": true"), std::string::npos) << c.id;
    EXPECT_NE(meta.find("1605632"), std::string::npos) << c.id;
    const std::string raw = ReadWholeFile(raw_path);
    ASSERT_FALSE(raw.empty()) << c.id;
    EXPECT_NE(raw.find(c.needle), std::string::npos) << c.id << " raw=" << raw;
    EXPECT_NE(raw.find("<|LOC_"), std::string::npos) << c.id;
    PaddleocrVlParseOptions opt;
    opt.task = "spotting";
    opt.frame_width = 800;
    opt.frame_height = 600;
    const PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(raw, opt);
    EXPECT_TRUE(parsed.elements.empty()) << c.id;
    ASSERT_EQ(parsed.spans.size(), 3u) << c.id << " text=" << parsed.text_utf8;
    EXPECT_NE(parsed.text_utf8.find(c.needle), std::string::npos) << c.id;
    EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
    EXPECT_GT(parsed.spans[0].quad.xy[2], parsed.spans[0].quad.xy[0]);
    EXPECT_GT(parsed.spans[0].quad.xy[5], parsed.spans[0].quad.xy[1]);
  }
  EXPECT_EQ(identical, 3);
}

TEST(PaddleocrVlBackend, EnHelloSmoke) {
  const std::string dir = ResolvePackDir();
  if (dir.empty()) GTEST_SKIP() << kUnpackHint;
  const std::string image_path = [] {
    const char* env = std::getenv("TEST_FIXTURES_DIR");
    if (env && env[0] != '\0') {
      return std::string(env) + "/ocr/en_hello.png";
    }
    return std::string("test/fixtures/ocr/en_hello.png");
  }();
  if (!fs::is_regular_file(image_path)) GTEST_SKIP() << image_path;
  PaddleocrVlBackend backend;
  OcrLoadOptions options;
  options.num_threads = 2;
  options.max_new_tokens = 16;
  backend.Load(dir, options);
  const ocr_test::RgbImage image = ocr_test::LoadRgbImage(image_path);
  OcrFrameView frame;
  frame.rgb = image.rgb.data();
  frame.width = image.width;
  frame.height = image.height;
  const OcrResult result = backend.Recognize(frame);
  EXPECT_EQ(result.spans.size(), 0u);
  EXPECT_FALSE(result.raw_utf8.empty() && result.text_utf8.empty());
  const std::string folded = result.text_utf8 + result.raw_utf8;
  EXPECT_NE(folded.find("Hello"), std::string::npos);
}
