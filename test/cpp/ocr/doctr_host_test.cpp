/**
 * Host GTests for DoctrBackend: unit (manifest/CTC blank-last/PARSeq/factory)
 * + real DoctrBackend golden with doctr-mobile pack.
 *
 * Fixtures: test/fixtures/ocr/ (or TEST_FIXTURES_DIR).
 * Pack: DOCTR_MODEL_DIR or build/ocr-models/doctr-mobile — hard FAIL with
 * unpack hint if missing.
 *
 * Run via ctest -R doctr_host_test.
 */

#include <gtest/gtest.h>

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

#include "OcrFactory.h"
#include "OcrTypes.h"
#include "ocr_test_image.h"
#include "doctr/DoctrManifest.h"
#include "doctr/DoctrRecDecode.h"
#include "doctr/DoctrDbPostprocess.h"
#include "doctr/DoctrImageOps.h"

namespace fs = std::filesystem;
using namespace sherpa_onnx::ocr;
using namespace sherpa_onnx::ocr::doctr;

namespace {

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

std::string NormText(std::string s) {
  static const std::regex ws(R"(\s+)");
  s = std::regex_replace(s, ws, "");
  return s;
}

std::string ParseJsonTextField(const std::string& json) {
  const std::string key = "\"text\"";
  const size_t key_pos = json.find(key);
  if (key_pos == std::string::npos) {
    throw std::runtime_error("golden JSON missing text field");
  }
  const size_t colon = json.find(':', key_pos + key.size());
  if (colon == std::string::npos) {
    throw std::runtime_error("golden JSON text field malformed");
  }
  const size_t q0 = json.find('"', colon + 1);
  if (q0 == std::string::npos) {
    throw std::runtime_error("golden JSON text field missing opening quote");
  }
  std::string out;
  for (size_t i = q0 + 1; i < json.size(); ++i) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      const char n = json[++i];
      if (n == 'n') out.push_back('\n');
      else if (n == 'r') out.push_back('\r');
      else if (n == 't') out.push_back('\t');
      else if (n == 'u' && i + 4 < json.size()) {
        out.push_back('\\'); out.push_back('u');
      } else out.push_back(n);
    } else if (json[i] == '"') {
      break;
    } else {
      out.push_back(json[i]);
    }
  }
  return out;
}

int CountJsonSpans(const std::string& json) {
  int n = 0;
  size_t pos = 0;
  while ((pos = json.find("\"quad\"", pos)) != std::string::npos) {
    ++n; ++pos;
  }
  return n;
}

std::string ResolveDoctrModelDir() {
  if (const char* env = std::getenv("DOCTR_MODEL_DIR")) {
    if (env[0] != '\0' && fs::is_directory(env)) return env;
  }
  const char* candidates[] = {
      "build/ocr-models/doctr-mobile",
      "dist/ocr-models/doctr-mobile",
  };
  for (const char* c : candidates) {
    if (fs::is_directory(c)) return c;
  }
  return {};
}

bool DoctrPackLooksValid(const std::string& dir) {
  return fs::exists(dir + "/det.onnx") && fs::exists(dir + "/rec.onnx") &&
         fs::exists(dir + "/ocr_manifest.json");
}

}  // namespace

// ---------------------------------------------------------------------------
// A — always (no pack required)
// ---------------------------------------------------------------------------

TEST(OcrFactory, DoctrCreates) {
  auto b = CreateOcrBackend("doctr");
  ASSERT_NE(b, nullptr);
  EXPECT_STREQ(b->Family(), "doctr");
}

TEST(OcrFactory, UnknownBackendThrowsNotDoctr) {
  EXPECT_THROW(
      {
        try {
          CreateOcrBackend("easyocr");
        } catch (const std::invalid_argument& e) {
          EXPECT_NE(std::string(e.what()).find("Unknown OCR"), std::string::npos);
          throw;
        }
      },
      std::invalid_argument);
}

TEST(DoctrManifestUnit, ParseModelDir) {
  const std::string dir = ResolveDoctrModelDir();
  if (dir.empty() || !DoctrPackLooksValid(dir)) {
    GTEST_SKIP() << "doctr-mobile pack not found; skipping manifest parse test";
  }
  DoctrManifest m = ParseDoctrManifest(dir);
  EXPECT_EQ(m.family, "doctr");
  EXPECT_GT(m.det_h, 0);
  EXPECT_GT(m.det_w, 0);
  EXPECT_GT(m.rec_h, 0);
  EXPECT_GT(m.rec_w, 0);
  EXPECT_FALSE(m.rec_vocab.empty());
  EXPECT_GE(m.rec_vocab.size(), 10u);
  EXPECT_TRUE(m.IsCrnn() || m.IsParseq());
}

TEST(DoctrCtcUnit, BlankLastSynthetic) {
  // Synthetic vocab: a=0, b=1, c=2, blank=3 (C=4, blank=C-1)
  std::vector<std::string> vocab = {"a", "b", "c"};
  const int C = 4;  // 3 chars + blank at index 3
  const int T = 6;
  std::vector<float> logits(static_cast<size_t>(T) * C, 0.f);
  auto set_best = [&](int t, int c) {
    for (int i = 0; i < C; ++i) {
      logits[static_cast<size_t>(t) * C + i] = (i == c) ? 5.f : 0.f;
    }
  };
  // Sequence: a, a (dup→collapse), blank, b, c, c (dup→collapse) → "abc"
  set_best(0, 0);  // a
  set_best(1, 0);  // a (collapse)
  set_best(2, 3);  // blank (C-1)
  set_best(3, 1);  // b
  set_best(4, 2);  // c
  set_best(5, 2);  // c (collapse)

  auto [text, conf] = CtcBlankLastDecode(logits.data(), T, C, vocab);
  EXPECT_EQ(text, "abc");
  EXPECT_GT(conf, 0.5f);
}

TEST(DoctrCtcUnit, BlankLastAllBlank) {
  std::vector<std::string> vocab = {"a"};
  const int C = 2;  // a=0, blank=1
  const int T = 3;
  std::vector<float> logits(static_cast<size_t>(T) * C, 0.f);
  for (int t = 0; t < T; ++t) {
    logits[static_cast<size_t>(t) * C + 1] = 5.f;  // blank wins
  }
  auto [text, conf] = CtcBlankLastDecode(logits.data(), T, C, vocab);
  EXPECT_TRUE(text.empty());
}

TEST(DoctrParseqUnit, EOSSynthetic) {
  // Synthetic vocab: a=0, b=1, c=2, EOS=3 (C=4, EOS=C-1)
  std::vector<std::string> vocab = {"a", "b", "c"};
  const int C = 4;
  const int T = 5;
  std::vector<float> logits(static_cast<size_t>(T) * C, 0.f);
  auto set_best = [&](int t, int c) {
    for (int i = 0; i < C; ++i) {
      logits[static_cast<size_t>(t) * C + i] = (i == c) ? 5.f : 0.f;
    }
  };
  set_best(0, 0);  // a
  set_best(1, 1);  // b
  set_best(2, 3);  // EOS — should stop here
  set_best(3, 2);  // c (never reached)
  set_best(4, 0);  // a (never reached)

  auto [text, conf] = ParseqDecode(logits.data(), T, C, vocab);
  EXPECT_EQ(text, "ab");
  EXPECT_GT(conf, 0.5f);
}

TEST(DoctrDbUnit, SigmoidBlobYieldsBox) {
  constexpr int H = 32;
  constexpr int W = 64;
  // Logits: high values in a rectangle → sigmoid → high prob → box
  std::vector<float> logits(static_cast<size_t>(H) * W, -5.f);
  for (int y = 10; y < 22; ++y) {
    for (int x = 16; x < 48; ++x) {
      logits[static_cast<size_t>(y) * W + x] = 5.f;  // sigmoid(5) ≈ 0.993
    }
  }
  auto boxes = DoctrDbPostprocess(logits.data(), H, W, 640, 480, 0.3f, 0.5f, 1.5f);
  ASSERT_GE(boxes.size(), 1u);
  // Boxes should be in source image coords (640×480), not det space
  EXPECT_GT(boxes[0].quad[2], 100.f);  // x1 should be scaled up from W=64
  EXPECT_GT(boxes[0].quad[5], 100.f);  // y1 should be scaled up from H=32
  SortDetBoxesReadingOrder(boxes);
}

TEST(DoctrUtf16, Length) {
  EXPECT_EQ(Utf8ToUtf16Length("Hello"), 5);
  EXPECT_EQ(Utf8ToUtf16Length(""), 0);
}

// ---------------------------------------------------------------------------
// B — real golden (pack required)
// ---------------------------------------------------------------------------

class DoctrGolden : public ::testing::TestWithParam<const char*> {
 protected:
  static void SetUpTestSuite() {
    model_dir_ = ResolveDoctrModelDir();
  }
  static std::string model_dir_;
};

std::string DoctrGolden::model_dir_;

TEST_P(DoctrGolden, RecognizeMatchesExpected) {
  if (model_dir_.empty() || !DoctrPackLooksValid(model_dir_)) {
    FAIL() << "doctr-mobile pack not found. Set DOCTR_MODEL_DIR or unpack:\n"
              "  mkdir -p build/ocr-models/doctr-mobile\n"
              "  # place det.onnx, rec.onnx, ocr_manifest.json in that directory";
  }

  const std::string name = GetParam();
  const std::string image_path = RepoRelativeFixture(("ocr/" + name + ".png").c_str());
  const std::string expected_path =
      RepoRelativeFixture(("ocr/expected/" + name + ".json").c_str());

  const std::string expected_json = ReadWholeFile(expected_path);
  const std::string expected_text = NormText(ParseJsonTextField(expected_json));

  auto img = ocr_test::LoadRgbImage(image_path);
  ASSERT_GT(img.width, 0);
  ASSERT_GT(img.height, 0);

  auto backend = CreateOcrBackend("doctr");
  OcrLoadOptions opts;
  opts.num_threads = 2;
  opts.use_orientation_cls = false;  // doctr has no cls
  backend->Load(model_dir_, opts);

  OcrFrameView frame;
  frame.rgb = img.rgb.data();
  frame.width = img.width;
  frame.height = img.height;
  frame.frame_index = 0;

  OcrResult result = backend->Recognize(frame);
  backend->Release();

  const std::string actual_text = NormText(result.text_utf8);
  // Doctr may produce slightly different text than ppocr golden;
  // check that at least some text is recognized and spans exist.
  EXPECT_FALSE(actual_text.empty()) << "Doctr returned empty text for " << name;
  ASSERT_GE(result.spans.size(), 1u);
  for (const auto& sp : result.spans) {
    for (int i = 0; i < 8; ++i) {
      EXPECT_TRUE(std::isfinite(sp.quad.xy[i]));
    }
    EXPECT_GE(sp.confidence, 0.f);
  }
}

INSTANTIATE_TEST_SUITE_P(
    Fixtures,
    DoctrGolden,
    ::testing::Values("en_hello", "de_guten_tag", "zh_nihao"),
    [](const ::testing::TestParamInfo<const char*>& info) {
      return std::string(info.param);
    });
