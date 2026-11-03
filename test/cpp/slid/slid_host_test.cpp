#include "sherpa-onnx-slid-wrapper.h"

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <gtest/gtest.h>
#include <string>
#include <vector>

namespace {

bool FileExists(const std::string& path) {
  std::ifstream in(path);
  return in.good();
}

std::string EnvOrEmpty(const char* key) {
  const char* v = std::getenv(key);
  return v != nullptr ? std::string(v) : std::string();
}

/** Master switch: real-model inference host tests (off by default / CI). */
bool HostInferenceEnabled() {
  const std::string v = EnvOrEmpty("SHERPA_HOST_INFERENCE");
  return v == "1" || v == "true" || v == "TRUE" || v == "yes" || v == "YES";
}

/** Feature fixture: SHERPA_SLID_ENCODER / SHERPA_SLID_DECODER absolute paths. */
bool HaveSlidFixture(std::string* encoder, std::string* decoder) {
  *encoder = EnvOrEmpty("SHERPA_SLID_ENCODER");
  *decoder = EnvOrEmpty("SHERPA_SLID_DECODER");
  if (encoder->empty() || decoder->empty()) {
    return false;
  }
  return FileExists(*encoder) && FileExists(*decoder);
}

}  // namespace

TEST(SlidHost, InitRejectsEmptyPaths) {
  sherpaonnx::SpokenLanguageIdWrapper slid;
  const auto r = slid.initialize("", "", -1, 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(slid.isInitialized());
}

TEST(SlidHost, InitRejectsMissingFiles) {
  sherpaonnx::SpokenLanguageIdWrapper slid;
  const auto r = slid.initialize("/no/such/encoder.onnx", "/no/such/decoder.onnx",
                                 -1, 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(slid.isInitialized());
}

TEST(SlidHost, ComputeBeforeInitFails) {
  sherpaonnx::SpokenLanguageIdWrapper slid;
  std::vector<float> pcm(1600, 0.f);
  const auto r = slid.compute(pcm, 16000);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
}

TEST(SlidHost, InitComputeDestroyWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP() << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  std::string encoder;
  std::string decoder;
  if (!HaveSlidFixture(&encoder, &decoder)) {
    GTEST_SKIP() << "Set SHERPA_SLID_ENCODER and SHERPA_SLID_DECODER to real "
                    "Whisper SLID .onnx paths";
  }

  sherpaonnx::SpokenLanguageIdWrapper slid;
  const auto init = slid.initialize(encoder, decoder, -1, 1, "cpu", false);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(slid.isInitialized());

  // ~1s of silence / noise at 16 kHz — model should still return a lang string.
  std::vector<float> pcm(16000, 0.01f);
  const auto computed = slid.compute(pcm, 16000);
  ASSERT_TRUE(computed.success) << computed.error;
  EXPECT_FALSE(computed.lang.empty());

  slid.release();
  EXPECT_FALSE(slid.isInitialized());
}
