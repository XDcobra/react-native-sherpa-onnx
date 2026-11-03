#include "sherpa-onnx-vad-engine-wrapper.h"

#include <cstdlib>
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

bool HostInferenceEnabled() {
  const std::string v = EnvOrEmpty("SHERPA_HOST_INFERENCE");
  return v == "1" || v == "true" || v == "TRUE" || v == "yes" || v == "YES";
}

bool HaveVadFixture(std::string* model, std::string* modelType) {
  *model = EnvOrEmpty("SHERPA_VAD_MODEL");
  *modelType = EnvOrEmpty("SHERPA_VAD_TYPE");
  if (modelType->empty()) {
    *modelType = "silero_vad";
  }
  if (model->empty()) return false;
  return FileExists(*model);
}

sherpaonnx::VadEngineConfig MakeConfig(const std::string& type,
                                       const std::string& path) {
  sherpaonnx::VadEngineConfig cfg;
  cfg.modelType = type;
  cfg.modelPath = path;
  cfg.sampleRate = 16000;
  cfg.numThreads = 1;
  cfg.provider = "cpu";
  cfg.debug = false;
  cfg.scoreThreshold = 0.5;
  cfg.minSilenceDurationMs = 250;
  cfg.minSpeechDurationMs = 250;
  cfg.maxSpeechDurationMs = 5000;
  cfg.windowSize = (type == "ten_vad") ? 256 : 512;
  cfg.bufferSizeSeconds = 30.f;
  return cfg;
}

}  // namespace

TEST(VadHost, InitRejectsEmptyPath) {
  sherpaonnx::VadEngineWrapper vad;
  const auto r = vad.initialize(MakeConfig("silero_vad", ""));
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(vad.isInitialized());
}

TEST(VadHost, InitRejectsBadModelType) {
  sherpaonnx::VadEngineWrapper vad;
  const auto r = vad.initialize(MakeConfig("unknown", "/tmp/m.onnx"));
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(vad.isInitialized());
}

TEST(VadHost, InitRejectsMissingFile) {
  sherpaonnx::VadEngineWrapper vad;
  const auto r =
      vad.initialize(MakeConfig("silero_vad", "/no/such/silero.onnx"));
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(vad.isInitialized());
}

TEST(VadHost, AcceptBeforeInitIsNoOp) {
  sherpaonnx::VadEngineWrapper vad;
  std::vector<float> pcm(512, 0.f);
  vad.acceptWaveform(pcm.data(), static_cast<int32_t>(pcm.size()));
  EXPECT_FALSE(vad.isSpeechDetected());
  EXPECT_TRUE(vad.popSegments().empty());
}

TEST(VadHost, InitAcceptFlushPopWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP() << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  std::string model;
  std::string modelType;
  if (!HaveVadFixture(&model, &modelType)) {
    GTEST_SKIP() << "Set SHERPA_VAD_MODEL (optional SHERPA_VAD_TYPE=silero_vad|ten_vad)";
  }

  sherpaonnx::VadEngineWrapper vad;
  const auto init = vad.initialize(MakeConfig(modelType, model));
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(vad.isInitialized());

  const int window = vad.windowSize();
  std::vector<float> silence(static_cast<size_t>(window), 0.f);
  std::vector<float> noise(static_cast<size_t>(window), 0.05f);
  for (int i = 0; i < 20; ++i) {
    vad.acceptWaveform(silence.data(), window);
  }
  for (int i = 0; i < 40; ++i) {
    vad.acceptWaveform(noise.data(), window);
  }
  for (int i = 0; i < 20; ++i) {
    vad.acceptWaveform(silence.data(), window);
  }
  vad.flush();
  // May or may not emit segments depending on model/thresholds; ensure no crash.
  (void)vad.popSegments();
  (void)vad.isSpeechDetected();

  vad.release();
  EXPECT_FALSE(vad.isInitialized());
}
