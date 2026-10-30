/**
 * Host GTests for DocVlmBackend.
 *
 * Grid math, DocTags, Family, and empty extras always run. Those unit tests
 * run on the PR job without the granite pack. Tokenizer / prompt tests and
 * DocVlmSmoke.EnHello run only when the pack is present (local unpack or
 * workflow_dispatch); otherwise they skip. Strict golden is opt-in.
 *
 * Pack: DOCVLM_MODEL_DIR, else build/ocr-models/docvlm-granite-258m-fp32
 * (or another granite dtype dir).
 */

#include <gtest/gtest.h>

#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "DocVlmBackend.h"
#include "DocVlmDocTags.h"
#include "DocVlmDocTagsPrefix.h"
#include "DocVlmImageOps.h"
#include "DocVlmPrompt.h"
#include "DocVlmTaskProfile.h"
#include "DocVlmTokenizer.h"
#include "OcrInstruction.h"
#include "OcrTypes.h"
#include "ocr_elements_json.h"
#include "ocr_test_image.h"

namespace fs = std::filesystem;
using namespace sherpa_onnx::ocr;
using namespace sherpa_onnx::ocr::doc_vlm;

namespace {

constexpr uint64_t kMiB = 1024ull * 1024ull;

const char* kUnpackHint =
    "docvlm-granite-258m pack not found. Unpack with:\n"
    "mkdir -p build/ocr-models\n"
    "curl -fsSL -o /tmp/docvlm-granite-258m-fp32.tar.bz2 \\\n"
    "  https://github.com/XDcobra/react-native-sherpa-onnx/releases/download/ocr-models/docvlm-granite-258m-fp32.tar.bz2\n"
    "tar xjf /tmp/docvlm-granite-258m-fp32.tar.bz2 -C build/ocr-models";

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
      "build/ocr-models/docvlm-granite-258m-fp32",
      "dist/ocr-models/docvlm-granite-258m-fp32",
      "build/ocr-models/docvlm-granite-258m-q8",
      "dist/ocr-models/docvlm-granite-258m-q8",
      "build/ocr-models/docvlm-granite-258m-fp16",
      "dist/ocr-models/docvlm-granite-258m-fp16",
      "build/ocr-models/docvlm-granite-258m-q4f16",
      "dist/ocr-models/docvlm-granite-258m-q4f16",
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

std::string TokenizerDirOrEmpty() {
  const std::string pack = PackDirOrEmpty();
  if (!pack.empty()) return pack;
  const char* candidates[] = {
      "example/.model-cache/docvlm-granite-258m-fp32",
      "example/.model-cache/docvlm-granite-258m",
      "build/ocr-models/docvlm-granite-258m-fp32",
      "build/ocr-models/docvlm-granite-258m/hf-src",
  };
  for (const char* candidate : candidates) {
    if (fs::is_regular_file(fs::path(candidate) / "tokenizer.json")) return candidate;
  }
  if (const char* env = std::getenv("DOCVLM_MODEL_DIR")) {
    if (env[0] != '\0' && fs::is_regular_file(fs::path(env) / "tokenizer.json")) {
      return env;
    }
  }
  return {};
}

const DocVlmTokenizer& TestTokenizer() {
  static const std::string dir = TokenizerDirOrEmpty();
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

/** Ids between the last `<fake_token_around_image>` (100339) and `<|end_of_text|>` (100257). */
std::vector<int32_t> UserTextIdsFromPrompt(const std::vector<int32_t>& prompt) {
  size_t eos = prompt.size();
  for (size_t i = 0; i < prompt.size(); ++i) {
    if (prompt[i] == 100257) eos = i;
  }
  if (eos == prompt.size()) {
    throw std::runtime_error("prompt_ids.json missing eos 100257");
  }
  size_t start = eos;
  for (size_t i = eos; i > 0; --i) {
    if (prompt[i - 1] == 100339) {
      start = i;
      break;
    }
  }
  return std::vector<int32_t>(prompt.begin() + static_cast<std::ptrdiff_t>(start),
                              prompt.begin() + static_cast<std::ptrdiff_t>(eos));
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
  if (TokenizerDirOrEmpty().empty()) {
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
  if (TokenizerDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  EXPECT_EQ(TestTokenizer().Encode("<|start_of_role|>"), (std::vector<int32_t>{100264}));
}

TEST(Tokenizer, DecodeSpecial) {
  if (TokenizerDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  EXPECT_EQ(tok.Decode({100327}), "<doctag>");
  EXPECT_EQ(tok.Decode({100257}), "<|end_of_text|>");
  const auto ids = tok.Encode("Convert this page to docling.");
  EXPECT_EQ(tok.Decode(ids), "Convert this page to docling.");
}

TEST(Prompt, EnHelloIds) {
  if (TokenizerDirOrEmpty().empty()) {
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
  if (TokenizerDirOrEmpty().empty()) {
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

TEST(Prompt, UserTextElementAndRegion) {
  DocVlmInstruction page;
  EXPECT_EQ(BuildDocVlmUserText(page, 900, 1200), "Convert this page to docling.");

  DocVlmInstruction table;
  table.task = DocVlmTask::kElement;
  table.element = DocVlmElement::kTable;
  EXPECT_EQ(BuildDocVlmUserText(table, 720, 360), "Convert table to OTSL.");

  DocVlmInstruction chart;
  chart.task = DocVlmTask::kElement;
  chart.element = DocVlmElement::kChart;
  EXPECT_EQ(BuildDocVlmUserText(chart, 720, 360), "Convert chart to table.");

  DocVlmInstruction formula;
  formula.task = DocVlmTask::kElement;
  formula.element = DocVlmElement::kFormula;
  EXPECT_EQ(BuildDocVlmUserText(formula, 640, 180), "Convert formula to LaTeX.");
  EXPECT_EQ(ProfileFor(formula).content_format, OcrContentFormat::kLatex);

  DocVlmInstruction code;
  code.task = DocVlmTask::kElement;
  code.element = DocVlmElement::kCode;
  EXPECT_EQ(BuildDocVlmUserText(code, 640, 360), "Convert code to text.");
  EXPECT_EQ(ProfileFor(code).content_format, OcrContentFormat::kCode);

  DocVlmInstruction region;
  region.task = DocVlmTask::kRegionText;
  region.region = OcrPixelRect{48, 55, 452, 33};
  EXPECT_EQ(BuildDocVlmUserText(region, 900, 1200),
            "OCR the text in a specific location: <loc_27><loc_23><loc_278><loc_37>");
  EXPECT_EQ(ProfileFor(region).content_format, OcrContentFormat::kPlain);

  DocVlmInstruction ident;
  ident.task = DocVlmTask::kIdentifyElement;
  ident.region = region.region;
  EXPECT_EQ(BuildDocVlmUserText(ident, 900, 1200),
            "Identify element at: <loc_27><loc_23><loc_278><loc_37>");
  EXPECT_TRUE(ProfileFor(ident).has_content);
  EXPECT_EQ(ProfileFor(ident).content_format, OcrContentFormat::kPlain);

  region.region = OcrPixelRect{800, 0, 200, 10};
  EXPECT_THROW(BuildDocVlmUserText(region, 900, 1200), OcrCodedError);
}

TEST(Prompt, RegionLocTokenizerParity) {
  if (TokenizerDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  struct Case {
    const char* fixture;
    OcrPixelRect region;
    DocVlmTask task;
  };
  const Case cases[] = {
      {"page_01", {48, 55, 452, 33}, DocVlmTask::kRegionText},
      {"page_02", {48, 55, 416, 33}, DocVlmTask::kRegionText},
      {"page_03", {48, 55, 384, 33}, DocVlmTask::kRegionText},
  };
  for (const auto& c : cases) {
    DocVlmInstruction inst;
    inst.task = c.task;
    inst.region = c.region;
    const std::string user = BuildDocVlmUserText(inst, 900, 1200);
    const std::vector<int32_t> ids = tok.Encode(user);
    const std::string rel =
        std::string("ocr/instructions/doc_vlm/regionText/") + c.fixture +
        "/prompt_ids.json";
    const std::vector<int32_t> golden =
        ParseIntArrayJson(ReadWholeFile(RepoRelativeFixture(rel.c_str())));
    const std::vector<int32_t> golden_user = UserTextIdsFromPrompt(golden);
    EXPECT_EQ(ids, golden_user) << c.fixture << " user=" << user;
  }
}

TEST(Prompt, TaskUserIdsMatchGoldens) {
  if (TokenizerDirOrEmpty().empty()) {
    GTEST_SKIP() << "tokenizer.json is in the doc_vlm pack; " << kUnpackHint;
  }
  const DocVlmTokenizer& tok = TestTokenizer();
  struct Case {
    DocVlmInstruction inst;
    const char* rel;
    int frame_w;
    int frame_h;
  };
  DocVlmInstruction page;
  DocVlmInstruction table;
  table.task = DocVlmTask::kElement;
  table.element = DocVlmElement::kTable;
  DocVlmInstruction chart;
  chart.task = DocVlmTask::kElement;
  chart.element = DocVlmElement::kChart;
  DocVlmInstruction formula;
  formula.task = DocVlmTask::kElement;
  formula.element = DocVlmElement::kFormula;
  DocVlmInstruction code;
  code.task = DocVlmTask::kElement;
  code.element = DocVlmElement::kCode;
  DocVlmInstruction region;
  region.task = DocVlmTask::kRegionText;
  region.region = OcrPixelRect{48, 55, 452, 33};
  DocVlmInstruction ident;
  ident.task = DocVlmTask::kIdentifyElement;
  ident.region = region.region;
  const Case cases[] = {
      {page, "ocr/instructions/doc_vlm/page/page_01/prompt_ids.json", 900, 1200},
      {table, "ocr/instructions/doc_vlm/element_table/table_01/prompt_ids.json", 720,
       360},
      {chart, "ocr/instructions/doc_vlm/element_chart/chart_01/prompt_ids.json", 720,
       360},
      {formula, "ocr/instructions/doc_vlm/element_formula/formula_01/prompt_ids.json",
       640, 180},
      {code, "ocr/instructions/doc_vlm/element_code/code_01/prompt_ids.json", 640, 360},
      {region, "ocr/instructions/doc_vlm/regionText/page_01/prompt_ids.json", 900, 1200},
      {ident, "ocr/instructions/doc_vlm/identifyElement/page_01/prompt_ids.json", 900,
       1200},
  };
  for (const auto& c : cases) {
    const std::string user = BuildDocVlmUserText(c.inst, c.frame_w, c.frame_h);
    const std::vector<int32_t> ids = tok.Encode(user);
    const std::vector<int32_t> golden =
        ParseIntArrayJson(ReadWholeFile(RepoRelativeFixture(c.rel)));
    const std::vector<int32_t> golden_user = UserTextIdsFromPrompt(golden);
    EXPECT_EQ(ids, golden_user) << c.rel << " user=" << user;
  }
}

std::string UnescapeJsonString(std::string_view s) {
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '\\' && i + 1 < s.size()) {
      const char n = s[i + 1];
      if (n == 'n') {
        out.push_back('\n');
        ++i;
        continue;
      }
      if (n == '"') {
        out.push_back('"');
        ++i;
        continue;
      }
      if (n == '\\') {
        out.push_back('\\');
        ++i;
        continue;
      }
    }
    out.push_back(s[i]);
  }
  return out;
}

std::string HfGenerateTextFromCacheJson(const std::string& json) {
  const auto hf = json.find("\"hf\"");
  if (hf == std::string::npos) {
    throw std::runtime_error("hf-128.json missing hf object");
  }
  const auto key = json.find("\"text\": \"", hf);
  if (key == std::string::npos) {
    throw std::runtime_error("hf-128.json missing hf.text");
  }
  std::string raw;
  for (size_t i = key + 9; i < json.size(); ++i) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      raw.push_back(json[i]);
      raw.push_back(json[i + 1]);
      ++i;
      continue;
    }
    if (json[i] == '"') break;
    raw.push_back(json[i]);
  }
  return UnescapeJsonString(raw);
}

TEST(DocTags, InstructionParityCacheParsesWithoutUnknownKinds) {
  const fs::path root("build/ocr-models/phase0-cache/doc_vlm");
  if (!fs::is_directory(root)) {
    GTEST_SKIP() << "Granite HF cache not pulled yet";
  }
  int parsed = 0;
  for (const auto& entry : fs::recursive_directory_iterator(root)) {
    if (!entry.is_regular_file() || entry.path().filename() != "hf-128.json") {
      continue;
    }
    const std::string text = HfGenerateTextFromCacheJson(ReadWholeFile(entry.path().string()));
    ASSERT_FALSE(text.empty()) << entry.path();
    const std::string path = entry.path().generic_string();
    if (path.find("/element_chart/") != std::string::npos) {
      EXPECT_THROW(ParseDocTags(text, 900, 1200, 0), OcrCodedError) << path;
      try {
        ParseDocTags(text, 900, 1200, 0);
      } catch (const OcrCodedError& e) {
        EXPECT_EQ(std::string(e.code()), kOcrErrParseUnknownKind) << path;
      }
      ++parsed;
      continue;
    }
    DocTagsParse tags = ParseDocTags(text, 900, 1200, 0);
    for (const auto& el : tags.elements) {
      if (el.has_quad) {
        for (int k = 0; k < 8; ++k) {
          EXPECT_TRUE(std::isfinite(el.quad.xy[k])) << entry.path();
        }
      }
    }
    if (path.find("/regionText/") != std::string::npos) {
      if (text.find("<text>") != std::string::npos) {
        // page_02 hits the 128-token cap and leaks DocTags after the title.
        ASSERT_FALSE(tags.elements.empty()) << path;
      } else {
        EXPECT_TRUE(tags.elements.empty()) << path;
        EXPECT_TRUE(tags.spans.empty()) << path;
        AdoptBareProse(tags, text);
        EXPECT_FALSE(tags.text_utf8.empty()) << path;
        EXPECT_EQ(tags.text_utf8.find('<'), std::string::npos) << path;
      }
    } else if (path.find("/identifyElement/") != std::string::npos) {
      EXPECT_TRUE(tags.elements.empty()) << path;
      AdoptBareProse(tags, text);
      EXPECT_FALSE(tags.text_utf8.empty()) << path;
      EXPECT_EQ(tags.text_utf8.find('<'), std::string::npos) << path;
    } else {
      ASSERT_FALSE(tags.elements.empty()) << path;
      if (path.find("/element_table/") != std::string::npos) {
        EXPECT_EQ(tags.elements[0].kind, OcrElementKind::kTable) << path;
        EXPECT_TRUE(tags.elements[0].has_quad) << path;
      } else if (path.find("/element_formula/") != std::string::npos) {
        EXPECT_EQ(tags.elements[0].kind, OcrElementKind::kFormula) << path;
        EXPECT_TRUE(tags.elements[0].has_quad) << path;
      } else if (path.find("/element_code/") != std::string::npos) {
        EXPECT_EQ(tags.elements[0].kind, OcrElementKind::kCode) << path;
        EXPECT_FALSE(tags.language.empty()) << path;
      } else if (path.find("/page/") != std::string::npos) {
        EXPECT_EQ(tags.elements[0].kind, OcrElementKind::kSectionHeader) << path;
        EXPECT_TRUE(tags.elements[0].has_quad) << path;
      }
    }
    ++parsed;
  }
  EXPECT_GE(parsed, 12);
}

TEST(DocTags, CodeLanguageTagAndIndent) {
  const DocTagsParse parsed = ParseDocTags(
      "<code><loc_0><loc_0><loc_500><loc_500><_Python_>def add(a, b):\n"
      "    return a + b\n</code>",
      640, 360, 0);
  EXPECT_EQ(parsed.language, "Python");
  EXPECT_EQ(parsed.text_utf8, "def add(a, b):\n    return a + b");
  ASSERT_EQ(parsed.elements.size(), 1u);
  EXPECT_EQ(parsed.elements[0].kind, OcrElementKind::kCode);
  EXPECT_TRUE(parsed.elements[0].has_quad);
}

TEST(DocTags, RegionTextBareProseHasNoElements) {
  DocTagsParse parsed =
      ParseDocTags("Quarterly Operations Report<|end_of_text|>", 900, 1200, 0);
  EXPECT_TRUE(parsed.elements.empty());
  EXPECT_TRUE(parsed.text_utf8.empty());
  AdoptBareProse(parsed, "Quarterly Operations Report<|end_of_text|>");
  EXPECT_EQ(parsed.text_utf8, "Quarterly Operations Report");
  EXPECT_TRUE(parsed.elements.empty());
  EXPECT_TRUE(parsed.spans.empty());
}

TEST(DocTags, InstructionGoldenRawsParseAndIdentity) {
  struct Case {
    const char* rel;
    bool identical;
    bool chart_unknown;
    bool bare_prose;
    const char* needle;
  };
  const Case cases[] = {
      {"page/page_01", false, false, false, "Quarterly Operations Report"},
      {"page/page_02", false, false, false, "Laboratory Safety Briefing"},
      {"page/page_03", false, false, false, "Harbor Traffic Summary"},
      {"element_table/table_01", true, false, false, "Item"},
      {"element_table/table_02", true, false, false, "City"},
      {"element_table/table_03", true, false, false, "Code"},
      {"element_chart/chart_01", false, true, false, nullptr},
      {"element_chart/chart_02", false, true, false, nullptr},
      {"element_chart/chart_03", false, true, false, nullptr},
      {"element_formula/formula_01", false, false, false, "E = m"},
      {"element_formula/formula_02", true, false, false, "a ^"},
      {"element_formula/formula_03", false, false, false, "F = m"},
      {"element_code/code_01", true, false, false, "def add"},
      {"element_code/code_02", false, false, false, "function greet"},
      {"element_code/code_03", true, false, false, "SELECT"},
      {"regionText/page_01", true, false, true, "Quarterly Operations Report"},
      {"regionText/page_02", false, false, false, "Wear gloves"},
      {"regionText/page_03", false, false, true, "Harbor Traffic Summary"},
      {"identifyElement/page_01", false, false, true, "Fixture page 01"},
      {"identifyElement/page_02", false, false, true, "Fixture page 02"},
      {"identifyElement/page_03", true, false, true, "Harbor Traffic Summary"},
  };
  int identical = 0;
  for (const auto& c : cases) {
    const std::string dir =
        std::string("ocr/instructions/doc_vlm/") + c.rel;
    const std::string meta_path = RepoRelativeFixture((dir + "/meta.json").c_str());
    const std::string raw_path = RepoRelativeFixture((dir + "/raw.txt").c_str());
    if (!fs::is_regular_file(meta_path) || !fs::is_regular_file(raw_path)) {
      GTEST_SKIP() << "instruction golden missing: " << dir;
    }
    const std::string meta = ReadWholeFile(meta_path);
    const bool meta_identical = meta.find("\"token_identical\": true") != std::string::npos;
    EXPECT_EQ(meta_identical, c.identical) << c.rel;
    if (meta_identical) ++identical;
    const std::string raw = ReadWholeFile(raw_path);
    ASSERT_FALSE(raw.empty()) << c.rel;
    if (c.chart_unknown) {
      EXPECT_THROW(ParseDocTags(raw, 720, 405, 0), OcrCodedError) << c.rel;
      continue;
    }
    DocTagsParse tags = ParseDocTags(raw, 900, 1200, 0);
    if (c.bare_prose) {
      EXPECT_TRUE(tags.elements.empty()) << c.rel;
      AdoptBareProse(tags, raw);
      EXPECT_FALSE(tags.text_utf8.empty()) << c.rel;
    } else {
      ASSERT_FALSE(tags.elements.empty()) << c.rel;
    }
    if (c.needle != nullptr) {
      EXPECT_NE(raw.find(c.needle), std::string::npos) << c.rel << " raw=" << raw;
    }
  }
  EXPECT_EQ(identical, 8);
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
  ASSERT_EQ(parsed.elements.size(), 1u);
  EXPECT_EQ(parsed.elements[0].kind, sherpa_onnx::ocr::OcrElementKind::kText);
  EXPECT_TRUE(parsed.elements[0].has_quad);
  EXPECT_TRUE(parsed.elements[0].has_utf16);
  EXPECT_EQ(parsed.elements[0].utf16_start, 0);
  EXPECT_EQ(parsed.elements[0].utf16_end, 5);
  EXPECT_EQ(ocr_test::ElementsToJson(parsed.elements),
            ocr_test::ReadElementsGolden("doctags_hello_quad.json"));
}

TEST(DocTags, TitleMarkdown) {
  const DocTagsParse parsed = ParseDocTags(
      "<doctag><title><loc_0><loc_0><loc_10><loc_10>Hi</title></doctag>", 1000, 240, 0);
  EXPECT_EQ(parsed.markdown_utf8, "# Hi");
  EXPECT_EQ(parsed.text_utf8, "Hi");
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
  ASSERT_EQ(parsed.elements.size(), 1u);
  EXPECT_EQ(parsed.elements[0].kind, sherpa_onnx::ocr::OcrElementKind::kTitle);
  EXPECT_EQ(ocr_test::ElementsToJson(parsed.elements),
            ocr_test::ReadElementsGolden("doctags_title.json"));
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
  ASSERT_EQ(parsed.elements.size(), 1u);
  EXPECT_EQ(parsed.elements[0].kind, sherpa_onnx::ocr::OcrElementKind::kTable);
  EXPECT_FALSE(parsed.elements[0].has_quad);
  EXPECT_EQ(ocr_test::ElementsToJson(parsed.elements),
            ocr_test::ReadElementsGolden("doctags_otsl_unclosed.json"));
}

TEST(DocTags, OtslClosedWithWrapperLocs) {
  const DocTagsParse parsed = ParseDocTags(
      "<otsl><loc_0><loc_0><loc_250><loc_250><fcel>A<fcel>B<nl><fcel>C<fcel>D</otsl>",
      1000, 240, 1);
  EXPECT_EQ(parsed.text_utf8, "A | B\nC | D");
  ASSERT_EQ(parsed.spans.size(), 1u);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
  EXPECT_EQ(parsed.spans[0].frame_index, 1);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 11);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[0], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[2], 500.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[5], 120.f);
}

TEST(DocTags, OtslCellLocsEmitLineSpans) {
  const DocTagsParse parsed = ParseDocTags(
      "<otsl><fcel><loc_0><loc_0><loc_100><loc_50>A"
      "<fcel><loc_100><loc_0><loc_200><loc_50>B<nl>"
      "<fcel><loc_0><loc_50><loc_100><loc_100>C"
      "<fcel><loc_100><loc_50><loc_200><loc_100>D</otsl>",
      1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "A | B\nC | D");
  ASSERT_EQ(parsed.spans.size(), 4u);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 1);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[0], 0.f);
  EXPECT_FLOAT_EQ(parsed.spans[0].quad.xy[2], 200.f);
  EXPECT_EQ(parsed.spans[1].utf16_start, 4);
  EXPECT_EQ(parsed.spans[1].utf16_end, 5);
  EXPECT_FLOAT_EQ(parsed.spans[1].quad.xy[0], 200.f);
  EXPECT_FLOAT_EQ(parsed.spans[1].quad.xy[2], 400.f);
  EXPECT_EQ(parsed.spans[2].utf16_start, 6);
  EXPECT_EQ(parsed.spans[2].utf16_end, 7);
  EXPECT_EQ(parsed.spans[3].utf16_start, 10);
  EXPECT_EQ(parsed.spans[3].utf16_end, 11);
  EXPECT_EQ(parsed.spans[3].level, OcrSpanLevel::kLine);
}

TEST(DocTags, OtslMixedCellLocsSkipCellsWithoutLoc) {
  const DocTagsParse parsed = ParseDocTags(
      "<otsl><loc_0><loc_0><loc_250><loc_250>"
      "<fcel><loc_0><loc_0><loc_100><loc_50>A<fcel>B<nl>"
      "<fcel>C<fcel><loc_100><loc_50><loc_200><loc_100>D</otsl>",
      1000, 240, 0);
  EXPECT_EQ(parsed.text_utf8, "A | B\nC | D");
  ASSERT_EQ(parsed.spans.size(), 2u);
  EXPECT_EQ(parsed.spans[0].level, OcrSpanLevel::kLine);
  EXPECT_EQ(parsed.spans[0].utf16_start, 0);
  EXPECT_EQ(parsed.spans[0].utf16_end, 1);
  EXPECT_EQ(parsed.spans[1].utf16_start, 10);
  EXPECT_EQ(parsed.spans[1].utf16_end, 11);
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

TEST(DocTags, UnknownTagThrowsParseUnknownKind) {
  EXPECT_THROW(ParseDocTags("<text>A</text><unknown>x</unknown><text>B</text>",
                            1000, 240, 0),
               OcrCodedError);
  try {
    ParseDocTags("<chart><loc_0><loc_0><loc_500><loc_500><unknown><fcel>A",
                 720, 405, 0);
  } catch (const OcrCodedError& e) {
    EXPECT_EQ(std::string(e.code()), kOcrErrParseUnknownKind);
    return;
  }
  FAIL() << "expected OCR_PARSE_UNKNOWN_KIND";
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

TEST(DocTagsPrefix, ElementModeAcceptsCodeAndOtslRoots) {
  DocTagsPrefix code(DocTagsPrefixKind::kElement);
  EXPECT_TRUE(code.Feed(
      "<code><loc_0><loc_0><loc_500><loc_500><_Python_>def add(a, b):</code>"));
  DocTagsPrefix table(DocTagsPrefixKind::kElement);
  EXPECT_TRUE(table.Feed("<otsl><loc_0><loc_0><loc_500><loc_500><fcel>Item"));
  DocTagsPrefix page;
  EXPECT_FALSE(page.Feed("<code>def add"));
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

TEST(DocTagsPrefix, AcceptsUnclosedOtslCloseThenText) {
  DocTagsPrefix prefix;
  EXPECT_TRUE(prefix.Feed(
      "<doctag><table><otsl><fcel>A<fcel>B<nl><fcel>C<fcel>D</otsl></table>"
      "<text>After</text></doctag>"));
  EXPECT_TRUE(prefix.closed_doctag());
}

TEST(DocTagsPrefix, AcceptsTableCloseWithoutOtslClose) {
  DocTagsPrefix prefix;
  EXPECT_TRUE(prefix.Feed(
      "<doctag><table><otsl><fcel>A<fcel>B</table><text>After</text></doctag>"));
  EXPECT_TRUE(prefix.closed_doctag());
}

TEST(OcrResult, ExtrasDefaultEmpty) {
  OcrResult result;
  EXPECT_TRUE(result.raw_utf8.empty());
  EXPECT_FALSE(result.has_content);
  EXPECT_TRUE(result.elements.empty());
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

  EXPECT_NE(result.raw_utf8.find("<doctag"), std::string::npos);
  EXPECT_NE(result.raw_utf8.find("</doctag>"), std::string::npos);
  EXPECT_FALSE(result.text_utf8.empty());
  EXPECT_NE(FoldAlnum(result.text_utf8).find("hello"), std::string::npos) << result.text_utf8;
  EXPECT_TRUE(result.has_content);
  EXPECT_EQ(result.content.format, OcrContentFormat::kMarkdown);
  EXPECT_FALSE(result.content.value.empty());
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
  EXPECT_EQ(result.raw_utf8, JsonStringField(golden, "doctags"));
  EXPECT_EQ(result.text_utf8, JsonStringField(golden, "text"));
  EXPECT_EQ(result.content.value, JsonStringField(golden, "markdown"));
}
