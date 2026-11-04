#include "sherpa-onnx-tts-engine-wrapper.h"

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

}  // namespace

TEST(TtsHost, NotInitializedUntilCreate) {
  sherpaonnx::TtsWrapper tts;
  EXPECT_FALSE(tts.isInitialized());
}

TEST(TtsHost, GenerateBeforeInitReturnsEmpty) {
  sherpaonnx::TtsWrapper tts;
  const auto audio = tts.generate("hello", 0, 1.0f);
  EXPECT_TRUE(audio.samples.empty());
}

TEST(TtsHost, InitCustomRejectsUnknownType) {
  sherpaonnx::TtsWrapper tts;
  sherpaonnx::TtsModelPaths paths;
  const auto r = tts.initializeCustom("not_a_real_model", paths);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(tts.isInitialized());
}

TEST(TtsHost, InitCustomRejectsMissingPaths) {
  sherpaonnx::TtsWrapper tts;
  sherpaonnx::TtsModelPaths paths;
  const auto r = tts.initializeCustom("vits", paths);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(tts.isInitialized());
}

TEST(TtsHost, ReleaseSafeWhenUninitialized) {
  sherpaonnx::TtsWrapper tts;
  tts.release();
  EXPECT_FALSE(tts.isInitialized());
}

TEST(TtsHost, InitGenerateWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP()
        << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  const std::string modelType = EnvOrEmpty("SHERPA_TTS_TYPE");
  if (modelType.empty()) {
    GTEST_SKIP() << "Set SHERPA_TTS_TYPE + path env vars "
                     "(e.g. SHERPA_TTS_MODEL / SHERPA_TTS_TOKENS for vits)";
  }

  sherpaonnx::TtsModelPaths paths;
  paths.ttsModel = EnvOrEmpty("SHERPA_TTS_MODEL");
  paths.tokens = EnvOrEmpty("SHERPA_TTS_TOKENS");
  paths.lexicon = EnvOrEmpty("SHERPA_TTS_LEXICON");
  paths.voices = EnvOrEmpty("SHERPA_TTS_VOICES");
  paths.acousticModel = EnvOrEmpty("SHERPA_TTS_ACOUSTIC");
  paths.vocoder = EnvOrEmpty("SHERPA_TTS_VOCODER");
  paths.encoder = EnvOrEmpty("SHERPA_TTS_ENCODER");
  paths.decoder = EnvOrEmpty("SHERPA_TTS_DECODER");
  paths.lmFlow = EnvOrEmpty("SHERPA_TTS_LM_FLOW");
  paths.lmMain = EnvOrEmpty("SHERPA_TTS_LM_MAIN");
  paths.textConditioner = EnvOrEmpty("SHERPA_TTS_TEXT_CONDITIONER");
  paths.vocabJson = EnvOrEmpty("SHERPA_TTS_VOCAB_JSON");
  paths.tokenScoresJson = EnvOrEmpty("SHERPA_TTS_TOKEN_SCORES");
  paths.durationPredictor = EnvOrEmpty("SHERPA_TTS_DURATION_PREDICTOR");
  paths.textEncoder = EnvOrEmpty("SHERPA_TTS_TEXT_ENCODER");
  paths.vectorEstimator = EnvOrEmpty("SHERPA_TTS_VECTOR_ESTIMATOR");
  paths.ttsJson = EnvOrEmpty("SHERPA_TTS_JSON");
  paths.unicodeIndexer = EnvOrEmpty("SHERPA_TTS_UNICODE_INDEXER");
  paths.voiceStyle = EnvOrEmpty("SHERPA_TTS_VOICE_STYLE");

  if (modelType == "vits" || modelType == "kokoro" || modelType == "kitten") {
    if (paths.ttsModel.empty() || !FileExists(paths.ttsModel) ||
        paths.tokens.empty() || !FileExists(paths.tokens)) {
      GTEST_SKIP() << "Missing SHERPA_TTS_MODEL / SHERPA_TTS_TOKENS";
    }
  }

  sherpaonnx::TtsWrapper tts;
  const auto init = tts.initializeCustom(modelType, paths, /*numThreads=*/1);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(tts.isInitialized());
  EXPECT_GT(tts.getSampleRate(), 0);

  const auto audio = tts.generate("hi", 0, 1.0f);
  (void)audio;

  tts.release();
  EXPECT_FALSE(tts.isInitialized());
}
