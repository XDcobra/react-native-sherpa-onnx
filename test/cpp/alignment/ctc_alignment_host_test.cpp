/**
 * Host-side tests for CTC alignment core + ONNX Runtime (Linux/macOS CI).
 * Fixtures under test/fixtures/alignment/ (or TEST_FIXTURES_DIR).
 *
 * - OrtSmoke / WavFixture / CtcAlignmentCore (tiny stub) / VocabProfile: no real pack.
 * - CtcAlignmentGolden: real wav2vec2-base-960h-int8 E2E on 0-en.wav (ALIGNMENT_MODEL_DIR).
 *   Missing pack → hard FAIL with unpack hint. Audio-host CI filters this suite out;
 *   test-alignment-host.yml downloads the pack and runs the full binary.
 */

#include <gtest/gtest.h>

#include <cstdlib>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

#include "onnxruntime/core/session/onnxruntime_c_api.h"
#include "sherpa_onnx_ctc_alignment.hpp"

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

/** Minimal 16-bit mono PCM WAV reader; returns float samples -1..1 and sample rate. */
bool ReadWavPcmMonoFloat(const std::string& path, std::vector<float>* out_samples, int32_t* out_rate) {
  out_samples->clear();
  *out_rate = 0;
  FILE* fp = std::fopen(path.c_str(), "rb");
  if (!fp) {
    return false;
  }
  char riff[4];
  if (std::fread(riff, 1, 4, fp) != 4 || std::memcmp(riff, "RIFF", 4) != 0) {
    std::fclose(fp);
    return false;
  }
  uint32_t riff_sz = 0;
  if (std::fread(&riff_sz, 4, 1, fp) != 1) {
    std::fclose(fp);
    return false;
  }
  char wave[4];
  if (std::fread(wave, 1, 4, fp) != 4 || std::memcmp(wave, "WAVE", 4) != 0) {
    std::fclose(fp);
    return false;
  }

  int32_t sample_rate = 0;
  uint16_t num_channels = 0;
  uint16_t bits = 0;
  int64_t data_bytes = -1;

  while (!std::feof(fp)) {
    char id[4];
    if (std::fread(id, 1, 4, fp) != 4) {
      break;
    }
    uint32_t chunk_size = 0;
    if (std::fread(&chunk_size, 4, 1, fp) != 1) {
      break;
    }
    long chunk_start = std::ftell(fp);

    if (std::memcmp(id, "fmt ", 4) == 0) {
      uint16_t audio_format = 0;
      if (chunk_size < 16 || std::fread(&audio_format, 2, 1, fp) != 1) {
        std::fseek(fp, chunk_start + static_cast<long>(chunk_size), SEEK_SET);
        continue;
      }
      if (std::fread(&num_channels, 2, 1, fp) != 1) {
        std::fclose(fp);
        return false;
      }
      uint32_t sr = 0;
      if (std::fread(&sr, 4, 1, fp) != 1) {
        std::fclose(fp);
        return false;
      }
      std::fseek(fp, 4, SEEK_CUR);
      std::fseek(fp, 2, SEEK_CUR);
      if (std::fread(&bits, 2, 1, fp) != 1) {
        std::fclose(fp);
        return false;
      }
      sample_rate = static_cast<int32_t>(sr);
      if (audio_format != 1 || num_channels != 1 || bits != 16) {
        std::fclose(fp);
        return false;
      }
    } else if (std::memcmp(id, "data", 4) == 0) {
      data_bytes = static_cast<int64_t>(chunk_size);
      const size_t n = static_cast<size_t>(chunk_size / 2);
      out_samples->resize(n);
      for (size_t i = 0; i < n; ++i) {
        int16_t s = 0;
        if (std::fread(&s, 2, 1, fp) != 1) {
          std::fclose(fp);
          return false;
        }
        (*out_samples)[i] = static_cast<float>(s) / 32768.0f;
      }
      break;
    }
    std::fseek(fp, chunk_start + static_cast<long>(chunk_size) + static_cast<long>(chunk_size & 1u), SEEK_SET);
  }
  std::fclose(fp);
  if (sample_rate <= 0 || data_bytes < 0 || out_samples->empty()) {
    return false;
  }
  *out_rate = sample_rate;
  return true;
}

static const OrtApi* OrtApiOrNull() {
  const OrtApiBase* base = OrtGetApiBase();
  if (!base) {
    return nullptr;
  }
  constexpr uint32_t kMin = 17;
  for (uint32_t ver = ORT_API_VERSION; ver >= kMin; --ver) {
    const OrtApi* api = base->GetApi(ver);
    if (api && api->CreateEnv && api->CreateSession) {
      return api;
    }
  }
  return nullptr;
}

void OrtCheck(const OrtApi* api, OrtStatus* st, const char* what) {
  if (!st) {
    return;
  }
  std::string msg = what;
  msg += ": ";
  msg += api->GetErrorMessage(st);
  api->ReleaseStatus(st);
  throw std::runtime_error(msg);
}

/** ORT integration smoke: session + Run() on relu_smoke.onnx (see file header). */
TEST(OrtSmoke, ReluSmokeRuns) {
  const std::string model = RepoRelativeFixture("alignment/relu_smoke.onnx");
  FILE* check = std::fopen(model.c_str(), "rb");
  ASSERT_TRUE(check != nullptr) << "missing fixture: " << model;
  std::fclose(check);

  const OrtApi* api = OrtApiOrNull();
  ASSERT_TRUE(api != nullptr);

  OrtEnv* env = nullptr;
  OrtSessionOptions* so = nullptr;
  OrtSession* sess = nullptr;
  OrtAllocator* alloc = nullptr;
  OrtMemoryInfo* mem = nullptr;
  OrtValue* inX = nullptr;
  OrtValue* outY = nullptr;
  char* name_in = nullptr;
  char* name_out = nullptr;

  OrtCheck(api, api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "ctc-test", &env), "CreateEnv");
  OrtCheck(api, api->CreateSessionOptions(&so), "CreateSessionOptions");
  OrtCheck(api, api->CreateSession(env, model.c_str(), so, &sess), "CreateSession");
  OrtCheck(api, api->GetAllocatorWithDefaultOptions(&alloc), "GetAllocator");

  size_t in_count = 0;
  size_t out_count = 0;
  OrtCheck(api, api->SessionGetInputCount(sess, &in_count), "SessionGetInputCount");
  OrtCheck(api, api->SessionGetOutputCount(sess, &out_count), "SessionGetOutputCount");
  ASSERT_EQ(in_count, 1u);
  ASSERT_EQ(out_count, 1u);

  OrtCheck(api, api->SessionGetInputName(sess, 0, alloc, &name_in), "SessionGetInputName");
  OrtCheck(api, api->SessionGetOutputName(sess, 0, alloc, &name_out), "SessionGetOutputName");

  OrtCheck(api, api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &mem), "CreateCpuMemoryInfo");

  float buf[2] = {-1.0f, 2.0f};
  int64_t shape[2] = {1, 2};
  OrtCheck(
      api,
      api->CreateTensorWithDataAsOrtValue(mem, buf, sizeof(buf), shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &inX),
      "CreateTensor in");

  const char* in_names[] = {name_in};
  const char* out_names[] = {name_out};
  const OrtValue* in_vals[] = {inX};
  OrtCheck(api, api->Run(sess, nullptr, in_names, in_vals, 1, out_names, 1, &outY), "Run");

  float* out_data = nullptr;
  OrtCheck(api, api->GetTensorMutableData(outY, reinterpret_cast<void**>(&out_data)), "GetTensorMutableData");
  ASSERT_NE(out_data, nullptr);
  EXPECT_NEAR(out_data[0], 0.0f, 1e-5f);
  EXPECT_NEAR(out_data[1], 2.0f, 1e-5f);

  if (name_in) {
    (void)api->AllocatorFree(alloc, name_in);
  }
  if (name_out) {
    (void)api->AllocatorFree(alloc, name_out);
  }
  if (outY) {
    api->ReleaseValue(outY);
  }
  if (inX) {
    api->ReleaseValue(inX);
  }
  if (mem) {
    api->ReleaseMemoryInfo(mem);
  }
  if (sess) {
    api->ReleaseSession(sess);
  }
  if (so) {
    api->ReleaseSessionOptions(so);
  }
  if (env) {
    api->ReleaseEnv(env);
  }
}

/** Fixture I/O: real WAV loads; RMS check avoids silent/broken files (see file header). */
TEST(WavFixture, ZeroEnWavLoadsAsPcmMono16) {
  const std::string path = RepoRelativeFixture("alignment/0-en.wav");
  std::vector<float> samples;
  int32_t rate = 0;
  ASSERT_TRUE(ReadWavPcmMonoFloat(path, &samples, &rate)) << path;
  EXPECT_GT(rate, 0);
  EXPECT_GT(samples.size(), 1000u);
  float energy = 0.f;
  for (float s : samples) {
    energy += s * s;
  }
  energy = std::sqrt(energy / static_cast<float>(samples.size()));
  EXPECT_GT(energy, 1e-6f);
}

/** End-to-end smoke for RunCtcAlignmentFromFloatPcm with stub model (see file header). */
TEST(CtcAlignmentCore, PipelineWithTinyLinearModel) {
  const std::string model = RepoRelativeFixture("alignment/tiny_ctc_linear.onnx");
  const std::string vocab_path = RepoRelativeFixture("alignment/tiny_vocab.json");
  FILE* m = std::fopen(model.c_str(), "rb");
  ASSERT_TRUE(m != nullptr) << "missing " << model;
  std::fclose(m);

  const std::string vocab_json = ReadWholeFile(vocab_path);
  std::vector<float> samples(100, 0.02f);
  auto result = sherpa_onnx::ctc_alignment::RunCtcAlignmentFromFloatPcm(
      model,
      "A",
      vocab_json,
      samples.data(),
      samples.size(),
      16000);

  ASSERT_FALSE(result.chars.empty());
  ASSERT_FALSE(result.words.empty());
  for (const auto& w : result.words) {
    EXPECT_GE(w.start_s, 0.0);
    EXPECT_GE(w.end_s, w.start_s);
  }
  for (const auto& c : result.chars) {
    EXPECT_GE(c.start_s, 0.0);
    EXPECT_GE(c.end_s, c.start_s);
  }
}

TEST(VocabProfile, MmsPrefersBlankZeroAndNoDelimiter) {
  using namespace sherpa_onnx::ctc_alignment;
  const std::string vocab_json =
      ReadWholeFile(RepoRelativeFixture("alignment/vocab_mms_fa.json"));
  const AlignmentVocabProfile profile = ResolveVocabProfile("", vocab_json);
  EXPECT_EQ(profile.blankId, 0);
  EXPECT_EQ(profile.unkId, 3);
  EXPECT_EQ(profile.wordDelimiterId, -1);
  EXPECT_EQ(profile.caseMode, CaseMode::kLower);

  const BuiltTokens built = BuildTokens("hello world", profile);
  ASSERT_FALSE(built.ids.empty());
  // No word-delimiter emissions when vocab has no '|'.
  for (int32_t wi : built.wordIndex) {
    EXPECT_GE(wi, 0);
  }
  // Two words → word indices 0 then 1.
  EXPECT_EQ(built.wordIndex.front(), 0);
  EXPECT_EQ(built.wordIndex.back(), 1);
  int32_t maxWord = 0;
  for (int32_t wi : built.wordIndex) {
    maxWord = std::max(maxWord, wi);
  }
  EXPECT_EQ(maxWord, 1);
}

TEST(VocabProfile, VoxPopuliKeepsUmlautsAndDelimiter) {
  using namespace sherpa_onnx::ctc_alignment;
  const std::string vocab_json =
      ReadWholeFile(RepoRelativeFixture("alignment/vocab_voxpopuli_de.json"));
  const AlignmentVocabProfile profile = ResolveVocabProfile("", vocab_json);
  EXPECT_EQ(profile.blankId, 0);
  EXPECT_EQ(profile.wordDelimiterId, 4);
  EXPECT_EQ(profile.caseMode, CaseMode::kLower);

  const BuiltTokens built = BuildTokens("für groß", profile);
  ASSERT_GE(built.ids.size(), 5u);
  // Expect a delimiter emission between the two words.
  bool saw_delim = false;
  for (int32_t wi : built.wordIndex) {
    if (wi < 0) {
      saw_delim = true;
      break;
    }
  }
  EXPECT_TRUE(saw_delim);
  // ü and ß must be present as alignable chars (not skipped).
  bool saw_u_umlaut = false;
  bool saw_eszett = false;
  for (const auto& d : built.display) {
    if (d == "ü") {
      saw_u_umlaut = true;
    }
    if (d == "ß") {
      saw_eszett = true;
    }
  }
  EXPECT_TRUE(saw_u_umlaut);
  EXPECT_TRUE(saw_eszett);
}

TEST(VocabProfile, XlsrUsesBracketPadAsBlank) {
  using namespace sherpa_onnx::ctc_alignment;
  const std::string vocab_json =
      ReadWholeFile(RepoRelativeFixture("alignment/vocab_xlsr_pad.json"));
  const AlignmentVocabProfile profile = ResolveVocabProfile("", vocab_json);
  EXPECT_EQ(profile.blankId, 50);
  EXPECT_EQ(profile.unkId, 49);
  EXPECT_EQ(profile.wordDelimiterId, 48);
  // Both cases present → kNone; lookup still finds lowercase letters.
  EXPECT_EQ(profile.caseMode, CaseMode::kNone);

  const BuiltTokens built = BuildTokens("Hi there", profile);
  ASSERT_FALSE(built.ids.empty());
  bool saw_delim = false;
  for (int32_t wi : built.wordIndex) {
    if (wi < 0) {
      saw_delim = true;
    }
  }
  EXPECT_TRUE(saw_delim);
}

TEST(VocabProfile, DefaultBakedEnglishUppercase) {
  using namespace sherpa_onnx::ctc_alignment;
  const AlignmentVocabProfile profile = ResolveVocabProfile("", "");
  EXPECT_EQ(profile.blankId, 0);
  EXPECT_EQ(profile.wordDelimiterId, 4);
  EXPECT_EQ(profile.caseMode, CaseMode::kUpper);

  const BuiltTokens built = BuildTokens("hi there", profile);
  ASSERT_FALSE(built.ids.empty());
  for (const auto& d : built.display) {
    if (d == "|") {
      continue;
    }
    for (char c : d) {
      EXPECT_TRUE(c < 'a' || c > 'z') << d;
    }
  }
}

// ---------------------------------------------------------------------------
// Real EN golden (wav2vec2-base-960h-int8)
// ---------------------------------------------------------------------------

std::string ResolveAlignmentModelDir() {
  if (const char* env = std::getenv("ALIGNMENT_MODEL_DIR")) {
    if (env[0] != '\0' && fs::is_directory(env)) {
      return env;
    }
  }
  const char* candidates[] = {
      "build/alignment-models/wav2vec2-base-960h-int8",
      "dist/alignment-models/wav2vec2-base-960h-int8",
  };
  for (const char* c : candidates) {
    if (fs::is_directory(c)) {
      return c;
    }
  }
  return {};
}

bool AlignmentPackLooksValid(const std::string& dir) {
  return fs::exists(dir + "/model.onnx");
}

std::string NormAlignText(std::string s) {
  static const std::regex ws(R"(\s+)");
  s = std::regex_replace(s, ws, "");
  return s;
}

std::string TrimCopy(std::string s) {
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) {
    s.pop_back();
  }
  size_t i = 0;
  while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r')) {
    ++i;
  }
  return s.substr(i);
}

/** Minimal parser for {"words":[{"text":"...","start_s":1.2,"end_s":1.4},...]} */
struct GoldenWord {
  std::string text;
  double start_s = 0.0;
  double end_s = 0.0;
};

std::vector<GoldenWord> ParseGoldenWords(const std::string& json) {
  std::vector<GoldenWord> out;
  size_t pos = 0;
  while (true) {
    const size_t tkey = json.find("\"text\"", pos);
    if (tkey == std::string::npos) {
      break;
    }
    const size_t q0 = json.find('"', json.find(':', tkey) + 1);
    if (q0 == std::string::npos) {
      break;
    }
    size_t q1 = q0 + 1;
    while (q1 < json.size() && json[q1] != '"') {
      if (json[q1] == '\\') {
        q1 += 2;
      } else {
        ++q1;
      }
    }
    GoldenWord w;
    w.text = json.substr(q0 + 1, q1 - q0 - 1);

    const size_t skey = json.find("\"start_s\"", q1);
    const size_t ekey = json.find("\"end_s\"", q1);
    if (skey == std::string::npos || ekey == std::string::npos) {
      break;
    }
    w.start_s = std::stod(json.substr(json.find(':', skey) + 1));
    w.end_s = std::stod(json.substr(json.find(':', ekey) + 1));
    out.push_back(w);
    pos = ekey + 1;
  }
  return out;
}

std::string FormatGoldenJson(
    const sherpa_onnx::ctc_alignment::CtcAlignmentResult& result) {
  std::ostringstream o;
  o << std::setprecision(6) << std::fixed;
  o << "{\"words\":[";
  for (size_t i = 0; i < result.words.size(); ++i) {
    if (i) {
      o << ',';
    }
    const auto& w = result.words[i];
    o << "{\"text\":\"" << w.text << "\",\"start_s\":" << w.start_s
      << ",\"end_s\":" << w.end_s << '}';
  }
  o << "]}";
  return o.str();
}

TEST(CtcAlignmentGolden, ZeroEnMatchesExpectedWords) {
  using namespace sherpa_onnx::ctc_alignment;

  const std::string model_dir = ResolveAlignmentModelDir();
  if (model_dir.empty() || !AlignmentPackLooksValid(model_dir)) {
    FAIL() << "wav2vec2-base-960h-int8 pack not found. Set ALIGNMENT_MODEL_DIR or unpack:\n"
              "  tar xjf dist/alignment-models/wav2vec2-base-960h-int8.tar.bz2 "
              "-C build/alignment-models\n"
              "  # or download:\n"
              "  curl -fsSL -o /tmp/wav2vec2-base-960h-int8.tar.bz2 \\\n"
              "    https://github.com/XDcobra/react-native-sherpa-onnx/releases/"
              "download/alignment-models/wav2vec2-base-960h-int8.tar.bz2\n"
              "  mkdir -p build/alignment-models && "
              "tar xjf /tmp/wav2vec2-base-960h-int8.tar.bz2 -C build/alignment-models";
  }

  const std::string model_path = model_dir + "/model.onnx";
  const std::string wav_path = RepoRelativeFixture("alignment/0-en.wav");
  const std::string text_path = RepoRelativeFixture("alignment/0-en.txt");
  const std::string expected_path = RepoRelativeFixture("alignment/expected/0-en.json");

  const std::string transcript = TrimCopy(ReadWholeFile(text_path));
  ASSERT_FALSE(transcript.empty());

  std::vector<float> samples;
  int32_t rate = 0;
  ASSERT_TRUE(ReadWavPcmMonoFloat(wav_path, &samples, &rate)) << wav_path;
  ASSERT_GT(samples.size(), 0u);
  ASSERT_GT(rate, 0);
  const double duration_s =
      static_cast<double>(samples.size()) / static_cast<double>(rate);

  CtcAlignmentResult result = RunCtcAlignmentFromFloatPcm(
      model_path, transcript, /*vocab_json_utf8=*/"", samples.data(), samples.size(), rate);

  ASSERT_FALSE(result.words.empty());
  for (size_t i = 0; i < result.words.size(); ++i) {
    EXPECT_GE(result.words[i].start_s, 0.0);
    EXPECT_GE(result.words[i].end_s, result.words[i].start_s);
    EXPECT_LE(result.words[i].end_s, duration_s + 0.05);
    if (i + 1 < result.words.size()) {
      EXPECT_LE(result.words[i].start_s, result.words[i + 1].start_s + 1e-6);
    }
  }

  std::string joined;
  for (size_t i = 0; i < result.words.size(); ++i) {
    if (i) {
      joined.push_back(' ');
    }
    joined += result.words[i].text;
  }
  EXPECT_EQ(NormAlignText(joined), NormAlignText(transcript));

  if (const char* dump = std::getenv("ALIGNMENT_DUMP_GOLDEN")) {
    if (dump[0] != '\0') {
      std::ofstream out(dump);
      ASSERT_TRUE(out) << "cannot write " << dump;
      out << FormatGoldenJson(result) << '\n';
      // Bootstrap mode: write golden and stop before comparing to expected file.
      return;
    }
  }

  const std::string expected_json = ReadWholeFile(expected_path);
  const auto expected = ParseGoldenWords(expected_json);
  ASSERT_EQ(result.words.size(), expected.size());
  constexpr double kTolS = 0.05;
  for (size_t i = 0; i < expected.size(); ++i) {
    EXPECT_EQ(result.words[i].text, expected[i].text) << "word index " << i;
    EXPECT_NEAR(result.words[i].start_s, expected[i].start_s, kTolS) << "word " << i;
    EXPECT_NEAR(result.words[i].end_s, expected[i].end_s, kTolS) << "word " << i;
  }
}

}  // namespace
