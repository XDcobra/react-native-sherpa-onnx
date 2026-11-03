#include "sherpa-onnx-kws-engine-wrapper.h"

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

bool HaveKwsFixture(std::string* encoder, std::string* decoder,
                    std::string* joiner, std::string* tokens,
                    std::string* keywords) {
  *encoder = EnvOrEmpty("SHERPA_KWS_ENCODER");
  *decoder = EnvOrEmpty("SHERPA_KWS_DECODER");
  *joiner = EnvOrEmpty("SHERPA_KWS_JOINER");
  *tokens = EnvOrEmpty("SHERPA_KWS_TOKENS");
  *keywords = EnvOrEmpty("SHERPA_KWS_KEYWORDS");
  if (encoder->empty() || decoder->empty() || joiner->empty() ||
      tokens->empty() || keywords->empty()) {
    return false;
  }
  return FileExists(*encoder) && FileExists(*decoder) && FileExists(*joiner) &&
         FileExists(*tokens) && FileExists(*keywords);
}

sherpaonnx::KwsEngineInitResult InitWith(
    sherpaonnx::KwsEngineWrapper* kws,
    const std::string& encoder,
    const std::string& decoder,
    const std::string& joiner,
    const std::string& tokens,
    const std::string& keywords) {
  return kws->initialize(encoder, decoder, joiner, tokens, keywords,
                         /*keywordsScore=*/1.5f,
                         /*keywordsThreshold=*/0.25f,
                         /*numTrailingBlanks=*/2,
                         /*maxActivePaths=*/4,
                         /*numThreads=*/1,
                         /*provider=*/"cpu",
                         /*debug=*/false);
}

}  // namespace

TEST(KwsHost, InitRejectsEmptyPaths) {
  sherpaonnx::KwsEngineWrapper kws;
  const auto r = InitWith(&kws, "", "/tmp/d.onnx", "/tmp/j.onnx", "/tmp/t.txt",
                          "/tmp/k.txt");
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(kws.isInitialized());
}

TEST(KwsHost, InitRejectsMissingFiles) {
  sherpaonnx::KwsEngineWrapper kws;
  const auto r = InitWith(&kws, "/no/such/encoder.onnx", "/no/such/decoder.onnx",
                          "/no/such/joiner.onnx", "/no/such/tokens.txt",
                          "/no/such/keywords.txt");
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(kws.isInitialized());
}

TEST(KwsHost, CreateStreamBeforeInitFails) {
  sherpaonnx::KwsEngineWrapper kws;
  EXPECT_FALSE(kws.createStream("s1", ""));
}

TEST(KwsHost, AcceptDecodeBeforeInitIsNoOp) {
  sherpaonnx::KwsEngineWrapper kws;
  std::vector<float> pcm(1600, 0.f);
  kws.acceptWaveform("missing", 16000, pcm.data(), pcm.size());
  EXPECT_FALSE(kws.isReady("missing"));
  kws.decode("missing");
  EXPECT_TRUE(kws.getResult("missing").keyword.empty());
}

TEST(KwsHost, InitCreateStreamAcceptFlushWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP()
        << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  std::string encoder;
  std::string decoder;
  std::string joiner;
  std::string tokens;
  std::string keywords;
  if (!HaveKwsFixture(&encoder, &decoder, &joiner, &tokens, &keywords)) {
    GTEST_SKIP() << "Set SHERPA_KWS_ENCODER/DECODER/JOINER/TOKENS/KEYWORDS";
  }

  sherpaonnx::KwsEngineWrapper kws;
  const auto init =
      InitWith(&kws, encoder, decoder, joiner, tokens, keywords);
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(kws.isInitialized());
  ASSERT_TRUE(kws.createStream("s1", ""));

  std::vector<float> silence(1600, 0.f);
  for (int i = 0; i < 10; ++i) {
    kws.acceptWaveform("s1", 16000, silence.data(), silence.size());
    while (kws.isReady("s1")) {
      kws.decode("s1");
      (void)kws.getResult("s1");
    }
  }
  kws.inputFinished("s1");
  while (kws.isReady("s1")) {
    kws.decode("s1");
    (void)kws.getResult("s1");
  }
  kws.releaseStream("s1");
  kws.unload();
  EXPECT_FALSE(kws.isInitialized());
}
