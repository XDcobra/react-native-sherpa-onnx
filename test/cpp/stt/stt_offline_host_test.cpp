#include "sherpa-onnx-stt-engine-wrapper.h"
#include "sherpa-onnx-model-detect.h"

#include <cstdlib>
#include <fstream>
#include <gtest/gtest.h>
#include <stdexcept>
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

bool HostInferenceEnabled() {
  const std::string v = EnvOrEmpty("SHERPA_HOST_INFERENCE");
  return v == "1" || v == "true" || v == "TRUE" || v == "yes" || v == "YES";
}

}  // namespace

TEST(SttOfflineHost, NotInitializedUntilCreate) {
  sherpaonnx::SttWrapper stt;
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOfflineHost, TranscribeBeforeInitThrows) {
  sherpaonnx::SttWrapper stt;
  std::vector<float> pcm(1600, 0.f);
  EXPECT_THROW(stt.transcribeSamples(pcm, 16000), std::runtime_error);
}

TEST(SttOfflineHost, InitCustomRejectsUnknownType) {
  sherpaonnx::SttWrapper stt;
  sherpaonnx::SttModelPaths paths;
  const auto r = stt.initializeCustom("not_a_real_model", paths);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOfflineHost, InitCustomRejectsMissingPaths) {
  sherpaonnx::SttWrapper stt;
  sherpaonnx::SttModelPaths paths;
  const auto r = stt.initializeCustom("whisper", paths);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOfflineHost, InitTranscribeWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP()
        << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  const std::string modelType = EnvOrEmpty("SHERPA_STT_OFFLINE_TYPE");
  const std::string tokens = EnvOrEmpty("SHERPA_STT_OFFLINE_TOKENS");
  if (modelType.empty() || tokens.empty() || !FileExists(tokens)) {
    GTEST_SKIP() << "Set SHERPA_STT_OFFLINE_TYPE + path env vars "
                     "(e.g. SHERPA_STT_OFFLINE_TOKENS, "
                     "SHERPA_STT_OFFLINE_WHISPER_ENCODER/DECODER)";
  }

  sherpaonnx::SttModelPaths paths;
  paths.tokens = tokens;
  paths.whisperEncoder = EnvOrEmpty("SHERPA_STT_OFFLINE_WHISPER_ENCODER");
  paths.whisperDecoder = EnvOrEmpty("SHERPA_STT_OFFLINE_WHISPER_DECODER");
  paths.encoder = EnvOrEmpty("SHERPA_STT_OFFLINE_ENCODER");
  paths.decoder = EnvOrEmpty("SHERPA_STT_OFFLINE_DECODER");
  paths.joiner = EnvOrEmpty("SHERPA_STT_OFFLINE_JOINER");
  paths.paraformerModel = EnvOrEmpty("SHERPA_STT_OFFLINE_PARAFORMER");
  paths.ctcModel = EnvOrEmpty("SHERPA_STT_OFFLINE_CTC");

  sherpaonnx::SttWrapper stt;
  const auto init = stt.initializeCustom(modelType, paths);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(stt.isInitialized());

  std::vector<float> silence(16000, 0.f);
  const auto result = stt.transcribeSamples(silence, 16000);
  (void)result;

  stt.release();
  EXPECT_FALSE(stt.isInitialized());
}
