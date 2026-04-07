/**
 * Host-side tests for CTC alignment core + ONNX Runtime smoke (Linux/macOS CI).
 * Fixtures under test/fixtures/alignment/ (or TEST_FIXTURES_DIR).
 *
 * What these tests do (regression / integration smoke, not phonetic ground truth):
 *
 * - OrtSmoke: Loads a tiny ReLU ONNX graph and checks one inference ([-1,2] -> [0,2]).
 *   Ensures the pinned ONNX Runtime host library loads, opens a model, and runs on CPU.
 *
 * - WavFixture: Loads 0-en.wav via the minimal WAV reader (16-bit mono PCM -> float).
 *   Ensures fixture paths and basic audio I/O work for alignment-related fixtures.
 *
 * - CtcAlignmentCore: Calls RunCtcAlignmentFromFloatPcm with tiny_ctc_linear.onnx and
 *   tiny_vocab.json on synthetic PCM. Ensures the production alignment pipeline returns
 *   non-empty words/chars with sane time bounds. Does not validate real STT quality or
 *   alignment accuracy against reference timestamps.
 */

#include <gtest/gtest.h>

#include <cstdlib>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

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

}  // namespace
