#include "sherpa-onnx-punct-engine-wrapper.h"

#include <cstdlib>
#include <fstream>
#include <gtest/gtest.h>
#include <string>

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

bool HaveOfflineFixture(std::string* model) {
  *model = EnvOrEmpty("SHERPA_PUNCT_OFFLINE_MODEL");
  return !model->empty() && FileExists(*model);
}

bool HaveOnlineFixture(std::string* model, std::string* bpe) {
  *model = EnvOrEmpty("SHERPA_PUNCT_ONLINE_MODEL");
  *bpe = EnvOrEmpty("SHERPA_PUNCT_ONLINE_BPE");
  if (model->empty() || bpe->empty()) return false;
  return FileExists(*model) && FileExists(*bpe);
}

}  // namespace

TEST(PunctuationHost, OfflineInitRejectsEmptyPath) {
  sherpaonnx::OfflinePunctuationWrapper punct;
  const auto r = punct.initialize("", 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(punct.isInitialized());
}

TEST(PunctuationHost, OfflineInitRejectsMissingFile) {
  sherpaonnx::OfflinePunctuationWrapper punct;
  const auto r =
      punct.initialize("/no/such/ct_transformer.onnx", 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(punct.isInitialized());
}

TEST(PunctuationHost, OfflineAddBeforeInitFails) {
  sherpaonnx::OfflinePunctuationWrapper punct;
  const auto r = punct.addPunctuation("hello world");
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
}

TEST(PunctuationHost, OnlineInitRejectsEmptyPaths) {
  sherpaonnx::OnlinePunctuationWrapper punct;
  const auto r = punct.initialize("", "", 1, "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(punct.isInitialized());
}

TEST(PunctuationHost, OnlineInitRejectsMissingFiles) {
  sherpaonnx::OnlinePunctuationWrapper punct;
  const auto r = punct.initialize("/no/such/cnn.onnx", "/no/such/bpe.vocab", 1,
                                  "cpu", false);
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(punct.isInitialized());
}

TEST(PunctuationHost, OnlineAddBeforeInitFails) {
  sherpaonnx::OnlinePunctuationWrapper punct;
  const auto r = punct.addPunctuation("hello world");
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
}

TEST(PunctuationHost, OfflineInitAddDestroyWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP() << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  std::string model;
  if (!HaveOfflineFixture(&model)) {
    GTEST_SKIP() << "Set SHERPA_PUNCT_OFFLINE_MODEL to a real ct_transformer "
                    ".onnx path";
  }

  sherpaonnx::OfflinePunctuationWrapper punct;
  const auto init = punct.initialize(model, 1, "cpu", false);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(punct.isInitialized());

  const auto result = punct.addPunctuation("how are you");
  ASSERT_TRUE(result.success) << result.error;
  EXPECT_FALSE(result.text.empty());

  punct.release();
  EXPECT_FALSE(punct.isInitialized());
}

TEST(PunctuationHost, OnlineInitAddDestroyWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP() << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  std::string model;
  std::string bpe;
  if (!HaveOnlineFixture(&model, &bpe)) {
    GTEST_SKIP() << "Set SHERPA_PUNCT_ONLINE_MODEL and SHERPA_PUNCT_ONLINE_BPE";
  }

  sherpaonnx::OnlinePunctuationWrapper punct;
  const auto init = punct.initialize(model, bpe, 1, "cpu", false);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(punct.isInitialized());

  const auto result = punct.addPunctuation("how are you");
  ASSERT_TRUE(result.success) << result.error;
  EXPECT_FALSE(result.text.empty());

  punct.release();
  EXPECT_FALSE(punct.isInitialized());
}
