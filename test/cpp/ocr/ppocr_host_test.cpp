/**
 * Host GTests for OCR: unit (CTC/DB/factory) + real PpocrBackend golden with ppocrv6-tiny.
 *
 * Fixtures: test/fixtures/ocr/ (or TEST_FIXTURES_DIR).
 * Pack: PPOCR_MODEL_DIR or build/ocr-models/ppocrv6-tiny — hard FAIL with unpack hint if missing.
 *
 * Replaces the former scripts/ocr-spike CLI; run via ctest -R ppocr_host_test.
 */

#include <gtest/gtest.h>

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "OcrCrop.h"
#include "OcrFactory.h"
#include "OcrInstruction.h"
#include "OcrTypes.h"
#include "ocr_test_image.h"
#include "ppocr/PpocrCtcDecoder.h"
#include "ppocr/PpocrDbPostprocess.h"
#include "ppocr/PpocrImageOps.h"

namespace fs = std::filesystem;
using namespace sherpa_onnx::ocr;
using namespace sherpa_onnx::ocr::ppocr;

namespace {

std::string RepoRelativeFixture(const char* relative_from_test_fixtures) {
  const char* env = std::getenv("TEST_FIXTURES_DIR");
  if (env && env[0] != '\0') {
    std::string base = env;
    if (base.back() != '/') {
      base += '/';
    }
    return base + relative_from_test_fixtures;
  }
  return std::string("test/fixtures/") + relative_from_test_fixtures;
}

std::string ReadWholeFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("cannot open: " + path);
  }
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
      if (n == 'n') {
        out.push_back('\n');
      } else if (n == 'r') {
        out.push_back('\r');
      } else if (n == 't') {
        out.push_back('\t');
      } else if (n == 'u' && i + 4 < json.size()) {
        // \uXXXX — UTF-8 golden fixtures store CJK as literal UTF-8, not escapes
        out.push_back('\\');
        out.push_back('u');
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

int CountJsonSpans(const std::string& json) {
  int n = 0;
  size_t pos = 0;
  while ((pos = json.find("\"quad\"", pos)) != std::string::npos) {
    ++n;
    ++pos;
  }
  return n;
}

std::string ResolveModelDir() {
  if (const char* env = std::getenv("PPOCR_MODEL_DIR")) {
    if (env[0] != '\0' && fs::is_directory(env)) {
      return env;
    }
  }
  const char* candidates[] = {
      "build/ocr-models/ppocrv6-tiny",
      "dist/ocr-models/ppocrv6-tiny",
  };
  for (const char* c : candidates) {
    if (fs::is_directory(c)) {
      return c;
    }
  }
  return {};
}

bool PackLooksValid(const std::string& dir) {
  return fs::exists(dir + "/det.onnx") && fs::exists(dir + "/rec.onnx") &&
         fs::exists(dir + "/rec_inference.yml");
}

}  // namespace

// ---------------------------------------------------------------------------
// A — always (no pack)
// ---------------------------------------------------------------------------

TEST(OcrFactory, PpocrAndAutoCreate) {
  auto a = CreateOcrBackend("ppocr");
  ASSERT_NE(a, nullptr);
  EXPECT_STREQ(a->Family(), "ppocr");
  auto b = CreateOcrBackend("auto");
  ASSERT_NE(b, nullptr);
  EXPECT_STREQ(b->Family(), "ppocr");
}

TEST(OcrFactory, UnknownBackendThrows) {
  EXPECT_THROW(
      {
        try {
          CreateOcrBackend("easyocr");
        } catch (const std::invalid_argument& e) {
          EXPECT_NE(std::string(e.what()).find("Unknown OCR"), std::string::npos);
          EXPECT_NE(std::string(e.what()).find("doc_vlm"), std::string::npos);
          throw;
        }
      },
      std::invalid_argument);
  EXPECT_THROW(CreateOcrBackend("DocVlm"), std::invalid_argument);
}

TEST(OcrFactory, DocVlmAndAliasesCreate) {
  for (const char* id :
       {"doc_vlm", "docvlm", "doc-vlm", "granite-docling", "docling"}) {
    auto backend = CreateOcrBackend(id);
    ASSERT_NE(backend, nullptr) << id;
    EXPECT_STREQ(backend->Family(), "doc_vlm") << id;
  }
}

TEST(PpocrCtcUnit, LoadDictAndGreedyDecode) {
  const std::string yml = RepoRelativeFixture("ocr/unit/mini_rec_dict.yml");
  auto dict = LoadCharacterDictFromYml(yml);
  ASSERT_GE(dict.size(), 2u);
  EXPECT_EQ(dict[0], "blank");
  // blank + a,b,c,' ',H,e,l,o,W,r,d
  EXPECT_GE(dict.size(), 12u);

  // indices: blank=0, a=1, b=2, ... find H,e,l,l,o
  auto idx = [&](const std::string& ch) -> int {
    for (size_t i = 0; i < dict.size(); ++i) {
      if (dict[i] == ch) {
        return static_cast<int>(i);
      }
    }
    return -1;
  };
  const int H = idx("H");
  const int e = idx("e");
  const int l = idx("l");
  const int o = idx("o");
  ASSERT_GT(H, 0);
  ASSERT_GT(e, 0);
  ASSERT_GT(l, 0);
  ASSERT_GT(o, 0);

  const int C = static_cast<int>(dict.size());
  const int T = 6;
  std::vector<float> logits(static_cast<size_t>(T) * C, 0.f);
  auto set_best = [&](int t, int c) {
    for (int i = 0; i < C; ++i) {
      logits[static_cast<size_t>(t) * C + i] = (i == c) ? 5.f : 0.f;
    }
  };
  set_best(0, H);
  set_best(1, e);
  set_best(2, l);
  set_best(3, l);  // CTC collapse duplicate
  set_best(4, 0);  // blank
  set_best(5, o);

  auto [text, conf] = CtcGreedyDecode(logits.data(), T, C, dict);
  EXPECT_EQ(text, "Helo");
  EXPECT_GT(conf, 0.5f);
  EXPECT_EQ(Utf8ToUtf16Length("你好"), 2);
}

TEST(PpocrDbUnit, SyntheticBlobYieldsBox) {
  constexpr int H = 32;
  constexpr int W = 64;
  std::vector<float> pred(static_cast<size_t>(H) * W, 0.f);
  // bright rectangle in center
  for (int y = 10; y < 22; ++y) {
    for (int x = 16; x < 48; ++x) {
      pred[static_cast<size_t>(y) * W + x] = 0.9f;
    }
  }
  ScaleParam scale;
  scale.src_w = W;
  scale.src_h = H;
  scale.dst_w = W;
  scale.dst_h = H;
  scale.ratio_w = 1.f;
  scale.ratio_h = 1.f;
  auto boxes = DbPostprocess(pred.data(), H, W, scale, 0.3f, 0.5f, 1.5f);
  ASSERT_GE(boxes.size(), 1u);
  EXPECT_EQ(boxes[0].quad[0] <= boxes[0].quad[2], true);
  SortDetBoxesReadingOrder(boxes);
}

// ---------------------------------------------------------------------------
// B — real golden (pack required)
// ---------------------------------------------------------------------------

class PpocrGolden : public ::testing::TestWithParam<const char*> {
 protected:
  static void SetUpTestSuite() {
    model_dir_ = ResolveModelDir();
  }

  static std::string model_dir_;
};

std::string PpocrGolden::model_dir_;

TEST_P(PpocrGolden, RecognizeMatchesExpected) {
  if (model_dir_.empty() || !PackLooksValid(model_dir_)) {
    FAIL() << "ppocrv6-tiny pack not found. Set PPOCR_MODEL_DIR or unpack:\n"
              "  tar xjf dist/ocr-models/ppocrv6-tiny.tar.bz2 -C build/ocr-models\n"
              "  # or download:\n"
              "  curl -fsSL -o /tmp/ppocrv6-tiny.tar.bz2 \\\n"
              "    https://github.com/XDcobra/react-native-sherpa-onnx/releases/download/ocr-models/ppocrv6-tiny.tar.bz2\n"
              "  mkdir -p build/ocr-models && tar xjf /tmp/ppocrv6-tiny.tar.bz2 -C build/ocr-models";
  }

  const std::string name = GetParam();
  const std::string image_path = RepoRelativeFixture(("ocr/" + name + ".png").c_str());
  const std::string expected_path =
      RepoRelativeFixture(("ocr/expected/" + name + ".json").c_str());

  const std::string expected_json = ReadWholeFile(expected_path);
  const std::string expected_text = NormText(ParseJsonTextField(expected_json));
  const int expected_spans = CountJsonSpans(expected_json);

  auto img = ocr_test::LoadRgbImage(image_path);
  ASSERT_GT(img.width, 0);
  ASSERT_GT(img.height, 0);

  auto backend = CreateOcrBackend("ppocr");
  OcrLoadOptions opts;
  opts.num_threads = 2;
  opts.use_orientation_cls = true;
  backend->Load(model_dir_, opts);

  OcrFrameView frame;
  frame.rgb = img.rgb.data();
  frame.width = img.width;
  frame.height = img.height;
  frame.frame_index = 0;

  OcrResult result = backend->Recognize(frame);
  backend->Release();

  EXPECT_EQ(NormText(result.text_utf8), expected_text);
  EXPECT_NEAR(static_cast<double>(result.spans.size()), expected_spans, 1.0);
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
    PpocrGolden,
    ::testing::Values("en_hello", "de_guten_tag", "zh_nihao"),
    [](const ::testing::TestParamInfo<const char*>& info) {
      return std::string(info.param);
    });

TEST(PpocrCrop, TranslateQuadsBackToFullFrame) {
  const std::string dir = ResolveModelDir();
  if (dir.empty() || !PackLooksValid(dir)) {
    FAIL() << "ppocrv6-tiny pack not found. Set PPOCR_MODEL_DIR or unpack.";
  }
  const auto img = ocr_test::LoadRgbImage(RepoRelativeFixture("ocr/en_hello.png"));
  ASSERT_GT(img.width, 8);
  ASSERT_GT(img.height, 8);

  auto backend = CreateOcrBackend("ppocr");
  OcrLoadOptions opts;
  opts.num_threads = 2;
  backend->Load(dir, opts);

  OcrFrameView frame;
  frame.rgb = img.rgb.data();
  frame.width = img.width;
  frame.height = img.height;

  const OcrPixelRect crop{img.width / 8, img.height / 8, (img.width * 3) / 4,
                          (img.height * 3) / 4};
  OcrCroppedFrame cropped(frame, crop);
  OcrResult result = backend->Recognize(cropped.view());
  backend->Release();
  ASSERT_GE(result.spans.size(), 1u);
  std::vector<OcrQuad> local;
  for (const auto& span : result.spans) local.push_back(span.quad);
  cropped.TranslateResult(result);
  ASSERT_EQ(result.spans.size(), local.size());
  const float dx = static_cast<float>(crop.x);
  const float dy = static_cast<float>(crop.y);
  for (size_t i = 0; i < result.spans.size(); ++i) {
    for (int k = 0; k < 4; ++k) {
      EXPECT_FLOAT_EQ(result.spans[i].quad.xy[k * 2], local[i].xy[k * 2] + dx);
      EXPECT_FLOAT_EQ(result.spans[i].quad.xy[k * 2 + 1], local[i].xy[k * 2 + 1] + dy);
    }
  }
}
