/**
 * Host GTests for DocVlmBackend.
 *
 * Grid math, DocTags, Family, and empty extras always run. Those unit tests
 * run on the PR job without the granite pack. Tokenizer / prompt tests and
 * DocVlmSmoke.EnHello run only when the pack is present (local unpack or
 * workflow_dispatch); otherwise they skip. Strict golden is opt-in.
 *
 * Pack: DOCVLM_MODEL_DIR, else build/ocr-models/docvlm-granite-258m,
 * else dist/ocr-models/docvlm-granite-258m.
 */

#include <gtest/gtest.h>

#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "DocVlmBackend.h"
#include "DocVlmDocTags.h"
#include "DocVlmDocTagsPrefix.h"
#include "DocVlmImageOps.h"
#include "DocVlmPrompt.h"
#include "DocVlmTokenizer.h"
#include "OcrTypes.h"
#include "ocr_test_image.h"

namespace fs = std::filesystem;
using namespace sherpa_onnx::ocr;
using namespace sherpa_onnx::ocr::doc_vlm;

namespace {

constexpr uint64_t kMiB = 1024ull * 1024ull;

const char* kUnpackHint =
    "docvlm-granite-258m pack not found. Unpack with:\n"
    "mkdir -p build/ocr-models\n"
    "curl -fsSL -o /tmp/docvlm-granite-258m.tar.bz2 \\\n"
    "  https://github.com/XDcobra/react-native-sherpa-onnx/releases/download/ocr-models/docvlm-granite-258m.tar.bz2\n"
    "tar xjf /tmp/docvlm-granite-258m.tar.bz2 -C build/ocr-models";

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
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open: " + path);
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

bool FileAtLeast(const fs::path& path, uint64_t bytes) {
  std::error_code ec;
  const auto size = fs::file_size(path, ec);
  return !ec && size >= bytes;
}

std::string ResolveDocVlmModelDir() {
  if (const char* env = std::getenv("DOCVLM_MODEL_DIR")) {
    if (env[0] != '\0' && fs::is_directory(env)) return env;
  }
  const char* candidates[] = {
      "build/ocr-models/docvlm-granite-258m",
      "dist/ocr-models/docvlm-granite-258m",
  };
  for (const char* candidate : candidates) {
    if (fs::is_directory(candidate)) return candidate;
  }
  return {};
}

bool DocVlmPackLooksValid(const std::string& dir) {
  if (dir.empty()) return false;
  const fs::path root(dir);
  const char* required[] = {
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
  return FileAtLeast(root / "vision_encoder.onnx_data", 300 * kMiB) &&
         FileAtLeast(root / "embed_tokens.onnx_data", 200 * kMiB) &&
         FileAtLeast(root / "decoder_model_merged.onnx_data", 600 * kMiB);
}

std::string PackDirOrEmpty() {
  const std::string dir = ResolveDocVlmModelDir();
  if (!DocVlmPackLooksValid(dir)) return {};
  return dir;
}

const DocVlmTokenizer& TestTokenizer() {
  static const std::string dir = PackDirOrEmpty();
  static DocVlmTokenizer tok = DocVlmTokenizer::Load((fs::path(dir) / "tokenizer.json").string());
  return tok;
}

void ExpectSize(const char* name, int width, int height, int step_a_w, int step_a_h,
                int step_b_w, int step_b_h, int rows, int cols, int num_images) {
  const DocVlmSize step_a = LongestEdgeSize(width, height, 2048);
  const DocVlmSize step_b = VisionEncoderSize(step_a.width, step_a.height, 512);
  const DocVlmGrid grid = SplitGrid(step_b.width, step_b.height, 512);
  EXPECT_EQ(step_a.width, step_a_w) << name;
  EXPECT_EQ(step_a.height, step_a_h) << name;
  EXPECT_EQ(step_b.width, step_b_w) << name;
  EXPECT_EQ(step_b.height, step_b_h) << name;
  EXPECT_EQ(grid.rows, rows) << name;
  EXPECT_EQ(grid.cols, cols) << name;
  EXPECT_EQ(grid.num_images, num_images) << name;
}

std::string ExpandedEnHello() {
  std::string text = "<|start_of_role|>user<|end_of_role|>";
  const char* rows[] = {"<row_1_col_1>", "<row_1_col_2>", "<row_1_col_3>", "<row_1_col_4>"};
  for (const char* row : rows) {
    text += "<fake_token_around_image>";
    text += row;
    for (int i = 0; i < 64; ++i) text += "<image>";
  }
  text += "\n\n<fake_token_around_image><global-img>";
  for (int i = 0; i < 64; ++i) text += "<image>";
  text += "<fake_token_around_image>Convert this page to docling.<|end_of_text|>\n";
  text += "<|start_of_role|>assistant<|end_of_role|>";
  return text;
}

std::vector<int32_t> ExpectedEnHelloIds() {
  std::vector<int32_t> ids;
  ids.insert(ids.end(), {100264, 882, 100265});
  const int32_t row_ids[] = {100258, 100259, 100261, 100262};
  for (int32_t row : row_ids) {
    ids.push_back(100339);
    ids.push_back(row);
    ids.insert(ids.end(), 64, 100270);
  }
  // Adjacent newlines in the chat string merge to ĊĊ (id 271).
  ids.push_back(271);
  ids.push_back(100339);
  ids.push_back(100340);
  ids.insert(ids.end(), 64, 100270);
  ids.push_back(100339);
  ids.insert(ids.end(), {12281, 420, 2199, 311, 4733, 2785, 13, 100257, 198, 100264, 78191, 100265});
  return ids;
}

int CountId(const std::vector<int32_t>& ids, int32_t id) {
  int n = 0;
  for (int32_t value : ids) {
    if (value == id) ++n;
  }
  return n;
}

std::string FoldAlnum(const std::string& text) {
  std::string out;
  for (unsigned char c : text) {
    if (std::isalnum(c)) out.push_back(static_cast<char>(std::tolower(c)));
  }
  return out;
}

std::string JsonStringField(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const size_t key_pos = json.find(needle);
  if (key_pos == std::string::npos) {
    throw std::runtime_error("golden JSON missing " + key);
  }
  const size_t colon = json.find(':', key_pos + needle.size());
  const size_t quote = json.find('"', colon + 1);
  if (colon == std::string::npos || quote == std::string::npos) {
    throw std::runtime_error("golden JSON field malformed: " + key);
  }
  std::string out;
  for (size_t i = quote + 1; i < json.size(); ++i) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      const char n = json[++i];
      if (n == 'n') out.push_back('\n');
      else if (n == 'r') out.push_back('\r');
      else if (n == 't') out.push_back('\t');
      else if (n == 'u' && i + 4 < json.size()) {
        unsigned cp = 0;
        for (int k = 0; k < 4; ++k) {
          const char h = json[++i];
          cp <<= 4;
          if (h >= '0' && h <= '9') cp += static_cast<unsigned>(h - '0');
          else if (h >= 'a' && h <= 'f') cp += static_cast<unsigned>(h - 'a' + 10);
          else if (h >= 'A' && h <= 'F') cp += static_cast<unsigned>(h - 'A' + 10);
        }
        if (cp < 0x80) out.push_back(static_cast<char>(cp));
        else if (cp < 0x800) {
          out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
          out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
          out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
          out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
          out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
      } else {
        out.push_back(n);
      }
    } else if (json[i] == '"') {
      break;
    } else {
      out.push_back(json[i]);
    }
  }
  return out;
}

}  // namespace

TEST(GridMath, Fixtures) {
  // Plan table lists height×width. These asserts are width×height from the resize rules.
  ExpectSize("en_hello", 1000, 240, 2048, 492, 2048, 512, 1, 4, 5);
  ExpectSize("de_guten_tag", 900, 200, 2048, 456, 2048, 512, 1, 4, 5);
  ExpectSize("zh_nihao", 600, 200, 2048, 682, 2048, 1024, 2, 4, 9);
  ExpectSize("square64", 64, 64, 2048, 2048, 2048, 2048, 4, 4, 17);
  ExpectSize("square512", 512, 512, 2048, 2048, 2048, 2048, 4, 4, 17);
}

TEST(GridMath, SingleImageBranch) {
  const DocVlmGrid grid = SplitGrid(512, 512, 512);
  EXPECT_EQ(grid.rows, 0);
  EXPECT_EQ(grid.cols, 0);
  EXPECT_EQ(grid.num_images, 1);
}

TEST(Tokenizer, UserSentence) {
  if (PackDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  EXPECT_EQ(tok.Encode("Convert this page to docling."),
            (std::vector<int32_t>{12281, 420, 2199, 311, 4733, 2785, 13}));
  EXPECT_EQ(tok.Encode("user"), (std::vector<int32_t>{882}));
  EXPECT_EQ(tok.Encode("assistant"), (std::vector<int32_t>{78191}));
  EXPECT_EQ(tok.Encode("\n"), (std::vector<int32_t>{198}));
}

TEST(Tokenizer, SpecialsBeforeBpe) {
  if (PackDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  EXPECT_EQ(TestTokenizer().Encode("<|start_of_role|>"), (std::vector<int32_t>{100264}));
}

TEST(Tokenizer, DecodeSpecial) {
  if (PackDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  EXPECT_EQ(tok.Decode({100327}), "<doctag>");
  EXPECT_EQ(tok.Decode({100257}), "<|end_of_text|>");
  const auto ids = tok.Encode("Convert this page to docling.");
  EXPECT_EQ(tok.Decode(ids), "Convert this page to docling.");
}

TEST(Prompt, EnHelloIds) {
  if (PackDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  const std::vector<int32_t> ids = BuildPromptIds(tok, 1, 4);
  const std::vector<int32_t> expected = ExpectedEnHelloIds();
  ASSERT_EQ(expected.size(), 347u);
  EXPECT_EQ(ids, expected);
  EXPECT_EQ(tok.Encode(ExpandedEnHello()), expected);
}

TEST(Prompt, ImageTokenCount) {
  if (PackDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  const int32_t image = tok.TokenId("<image>");
  EXPECT_EQ(image, 100270);
  EXPECT_EQ(CountId(BuildPromptIds(tok, 0, 0), image), 64);
  EXPECT_EQ(CountId(BuildPromptIds(tok, 1, 4), image), 320);
  EXPECT_EQ(CountId(BuildPromptIds(tok, 2, 4), image), 576);
  EXPECT_EQ(CountId(BuildPromptIds(tok, 4, 4), image), 1088);
}

TEST(DocTags, HelloQuad) {
  const DocTagsParse parsed = ParseDocTags(
      "<doctag><text><loc_0><loc_0><loc_250><loc_250>Hello</text></doctag>", 1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "Hello");
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 5);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[0], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[1], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[2], 500.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[3], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[4], 500.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[5], 120.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[6], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[7], 120.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].confidence, 1.f);
  EXPECT_EQ(parsed.spans[0].frame_index, 0);
}

TEST(DocTags, TitleMarkdown) {
  const DocTagsParse parsed = ParseDocTags(
      "<doctag><title><loc_0><loc_0><loc_10><loc_10>Hi</title></doctag>", 1000, 240, 0);
  EXPECT_EQ(parsed.markdown_utf8, "# Hi");
  EXPECT_EQ(parsed.text_utf8, "Hi");
}

TEST(DocTags, FallbackStripsTags) {
  const DocTagsParse parsed = ParseDocTags("<doctag>Hello</doctag>", 1000, 240, 3);
  EXPECT_TRUE(parsed.text_utf8.empty());
  EXPECT_TRUE(parsed.markdown_utf8.empty());
  EXPECT_TRUE(parsed.spans.empty());
}

TEST(DocTags, OtslUnclosedTwoByTwo) {
  const DocTagsParse parsed =
      ParseDocTags("<fcel>A<fcel>B<nl><fcel>C<fcel>D", 1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "A | B\nC | D");
  EXPECT_EQ(parsed.markdown_utf8, "| A | B |\n| --- | --- |\n| C | D |");
  EXPECT_TRUE(parsed.spans.empty());
}

TEST(DocTags, OtslClosedWithWrapperLocs) {
  const DocTagsParse parsed = ParseDocTags(
      "<otsl><loc_0><loc_0><loc_250><loc_250><fcel>A<fcel>B<nl><fcel>C<fcel>D</otsl>",
      1000, 240, 1);
  EXPECT_EQ(parsed.text_utf8, "A | B\nC | D");
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kBlock);
  EXPECT_EQ(parsed.spans[0].frame_index, 1);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 11);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[0], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[2], 500.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[5], 120.f);
}

TEST(DocTags, OtslEmptyCellKeepsColumn) {
  const DocTagsParse parsed =
      ParseDocTags("<fcel>A<ecel><fcel>B<nl><fcel>C<fcel>D<fcel>E", 1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "A |  | B\nC | D | E");
  EXPECT_EQ(parsed.markdown_utf8,
            "| A |  | B |\n| --- | --- | --- |\n| C | D | E |");
}

TEST(DocTags, OtslCaptionBeforeTable) {
  const DocTagsParse parsed = ParseDocTags(
      "<otsl><caption>Notes</caption><fcel>A<fcel>B<nl><fcel>C<fcel>D</otsl>",
      1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "Notes\nA | B\nC | D");
  EXPECT_EQ(parsed.markdown_utf8,
            "Notes\n| A | B |\n| --- | --- |\n| C | D |");
}

TEST(DocTags, UnknownTagDoesNotDropNeighbors) {
  const DocTagsParse parsed = ParseDocTags(
      "<text>A</text><unknown>x</unknown><text>B</text>", 1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "A\nB");
}

TEST(DocTags, TruncatedTextIsBestEffort) {
  const DocTagsParse parsed = ParseDocTags("<text>Hello", 1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "Hello");
  ASSERT_EQ(parsed.spans.size(), 1u);
}

TEST(DocTagsPrefix, RejectsStartWithoutDoctag) {
  DocTagsPrefix prefix;
  EXPECT_FALSE(prefix.Feed("Fo"));
}

TEST(DocTagsPrefix, RejectsLocWithoutOpen) {
  DocTagsPrefix prefix;
  EXPECT_FALSE(prefix.Feed("<loc_0>"));
}

TEST(DocTagsPrefix, RejectsPromptOnly) {
  DocTagsPrefix start;
  EXPECT_FALSE(start.Feed("<image>"));
  DocTagsPrefix after_open;
  EXPECT_TRUE(after_open.Feed("<doctag>"));
  EXPECT_FALSE(after_open.Feed("<fake_token_around_image>"));
  DocTagsPrefix role;
  EXPECT_TRUE(role.Feed("<doctag>"));
  EXPECT_FALSE(role.Feed("<|start_of_role|>"));
  DocTagsPrefix tile;
  EXPECT_TRUE(tile.Feed("<doctag>"));
  EXPECT_FALSE(tile.Feed("<row_1_col_2>"));
}

TEST(DocTagsPrefix, RejectsTextAfterClose) {
  DocTagsPrefix prefix;
  EXPECT_TRUE(prefix.Feed("<doctag></doctag>"));
  EXPECT_TRUE(prefix.closed_doctag());
  EXPECT_FALSE(prefix.Feed("Hello"));
}

TEST(DocTagsPrefix, AcceptsMiniDocument) {
  DocTagsPrefix prefix;
  EXPECT_TRUE(prefix.Feed("\n<doctag><text>Hi</text></doctag>"));
  EXPECT_TRUE(prefix.closed_doctag());
}

TEST(DocTagsPrefix, AcceptsUnclosedOtslPrefix) {
  DocTagsPrefix prefix;
  EXPECT_TRUE(prefix.Feed("<doctag><otsl><fcel>A<fcel>B<nl>"));
  EXPECT_FALSE(prefix.closed_doctag());
}

TEST(OcrResult, ExtrasDefaultEmpty) {
  OcrResult result;
  EXPECT_TRUE(result.doctags_utf8.empty());
  EXPECT_TRUE(result.markdown_utf8.empty());
  EXPECT_TRUE(result.stop_reason.empty());
  EXPECT_TRUE(result.complete);
  OcrLoadOptions options;
  EXPECT_EQ(options.max_new_tokens, 0);
}

TEST(DocVlmBackend, Family) {
  DocVlmBackend backend;
  EXPECT_STREQ(backend.Family(), "doc_vlm");
}

TEST(DocVlmSmoke, EnHello) {
  const std::string dir = PackDirOrEmpty();
  if (dir.empty()) {
    GTEST_SKIP() << kUnpackHint;
  }
  const std::string image_path = RepoRelativeFixture("ocr/en_hello.png");
  const ocr_test::RgbImage image = ocr_test::LoadRgbImage(image_path);

  OcrLoadOptions options;
  options.num_threads = 2;
  options.max_new_tokens = 512;

  const auto t0 = std::chrono::steady_clock::now();
  DocVlmBackend backend;
  backend.Load(dir, options);
  OcrFrameView frame;
  frame.rgb = image.rgb.data();
  frame.width = image.width;
  frame.height = image.height;
  frame.frame_index = 0;
  const OcrResult result = backend.Recognize(frame);
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - t0)
                      .count();
  std::fprintf(stderr, "[SherpaOnnx:ocr] doc_vlm smoke wall_ms=%lld\n",
               static_cast<long long>(ms));

  EXPECT_NE(result.doctags_utf8.find("<doctag"), std::string::npos);
  EXPECT_NE(result.doctags_utf8.find("</doctag>"), std::string::npos);
  EXPECT_FALSE(result.text_utf8.empty());
  EXPECT_NE(FoldAlnum(result.text_utf8).find("hello"), std::string::npos) << result.text_utf8;
  EXPECT_FALSE(result.markdown_utf8.empty());
  ASSERT_GE(result.spans.size(), 1u);
  for (const OcrSpan& span : result.spans) {
    EXPECT_FLOAT_EQ(span.confidence, 1.f);
    EXPECT_EQ(span.frame_index, 0);
    for (float xy : span.quad.xy) EXPECT_TRUE(std::isfinite(xy));
  }
}

TEST(DocVlmStrict, EnHello) {
  const char* flag = std::getenv("DOCVLM_STRICT_GOLDEN");
  if (flag == nullptr || std::string(flag) != "1") {
    GTEST_SKIP() << "set DOCVLM_STRICT_GOLDEN=1 to compare docvlm_en_hello.json";
  }
  const std::string golden_path = RepoRelativeFixture("ocr/expected/docvlm_en_hello.json");
  if (!fs::is_regular_file(golden_path)) {
    GTEST_SKIP() << "strict golden missing: " << golden_path;
  }
  const std::string dir = PackDirOrEmpty();
  if (dir.empty()) {
    GTEST_SKIP() << kUnpackHint;
  }
  const ocr_test::RgbImage image = ocr_test::LoadRgbImage(RepoRelativeFixture("ocr/en_hello.png"));
  OcrLoadOptions options;
  options.num_threads = 2;
  options.max_new_tokens = 512;
  DocVlmBackend backend;
  backend.Load(dir, options);
  OcrFrameView frame;
  frame.rgb = image.rgb.data();
  frame.width = image.width;
  frame.height = image.height;
  frame.frame_index = 0;
  const OcrResult result = backend.Recognize(frame);
  const std::string golden = ReadWholeFile(golden_path);
  EXPECT_EQ(result.doctags_utf8, JsonStringField(golden, "doctags"));
  EXPECT_EQ(result.text_utf8, JsonStringField(golden, "text"));
  EXPECT_EQ(result.markdown_utf8, JsonStringField(golden, "markdown"));
}
