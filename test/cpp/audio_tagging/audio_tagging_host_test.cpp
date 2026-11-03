#include "sherpa-onnx-audio-tagging-wrapper.h"

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

/** Master switch: real-model inference host tests (off by default / CI). */
bool HostInferenceEnabled() {
  const std::string v = EnvOrEmpty("SHERPA_HOST_INFERENCE");
  return v == "1" || v == "true" || v == "TRUE" || v == "yes" || v == "YES";
}

/**
 * Feature fixture:
 *   SHERPA_AUDIO_TAGGING_MODEL
 *   SHERPA_AUDIO_TAGGING_LABELS
 *   optional SHERPA_AUDIO_TAGGING_TYPE=ced|zipformer (default ced)
 */
bool HaveAudioTaggingFixture(std::string* model, std::string* labels,
                             std::string* modelType) {
  *model = EnvOrEmpty("SHERPA_AUDIO_TAGGING_MODEL");
  *labels = EnvOrEmpty("SHERPA_AUDIO_TAGGING_LABELS");
  *modelType = EnvOrEmpty("SHERPA_AUDIO_TAGGING_TYPE");
  if (modelType->empty()) {
    *modelType = "ced";
  }
  if (model->empty() || labels->empty()) {
    return false;
  }
  return FileExists(*model) && FileExists(*labels);
}

}  // namespace

TEST(AudioTaggingHost, InitRejectsEmptyPaths) {
  sherpaonnx::AudioTaggingWrapper tagger;
  const auto r = tagger.initialize("ced", "", "", 5, 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(tagger.isInitialized());
}

TEST(AudioTaggingHost, InitRejectsBadModelType) {
  sherpaonnx::AudioTaggingWrapper tagger;
  const auto r =
      tagger.initialize("unknown", "/tmp/m.onnx", "/tmp/labels.txt", 5, 1,
                        "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(tagger.isInitialized());
}

TEST(AudioTaggingHost, InitRejectsMissingFiles) {
  sherpaonnx::AudioTaggingWrapper tagger;
  const auto r = tagger.initialize(
      "ced", "/no/such/model.onnx", "/no/such/labels.txt", 5, 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(tagger.isInitialized());
}

TEST(AudioTaggingHost, ComputeBeforeInitFails) {
  sherpaonnx::AudioTaggingWrapper tagger;
  std::vector<float> pcm(1600, 0.f);
  const auto r = tagger.compute(pcm, 16000);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
}

TEST(AudioTaggingHost, InitComputeDestroyWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP() << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  std::string model;
  std::string labels;
  std::string modelType;
  if (!HaveAudioTaggingFixture(&model, &labels, &modelType)) {
    GTEST_SKIP() << "Set SHERPA_AUDIO_TAGGING_MODEL and "
                    "SHERPA_AUDIO_TAGGING_LABELS (optional "
                    "SHERPA_AUDIO_TAGGING_TYPE=ced|zipformer)";
  }

  sherpaonnx::AudioTaggingWrapper tagger;
  const auto init =
      tagger.initialize(modelType, model, labels, 5, 1, "cpu", false);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(tagger.isInitialized());

  // ~1s of low-amplitude noise at 16 kHz.
  std::vector<float> pcm(16000, 0.01f);
  const auto computed = tagger.compute(pcm, 16000);
  ASSERT_TRUE(computed.success) << computed.error;
  EXPECT_FALSE(computed.events.empty());

  tagger.release();
  EXPECT_FALSE(tagger.isInitialized());
}
