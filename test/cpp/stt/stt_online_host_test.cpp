#include "sherpa-onnx-online-stt-engine-wrapper.h"

#include <cstdlib>
#include <filesystem>
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

TEST(SttOnlineHost, NotInitializedUntilCreate) {
  sherpaonnx::OnlineSttWrapper stt;
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOnlineHost, CreateStreamBeforeInitFails) {
  sherpaonnx::OnlineSttWrapper stt;
  EXPECT_FALSE(stt.createStream("s1", ""));
}

TEST(SttOnlineHost, InitCustomRejectsUnknownType) {
  sherpaonnx::OnlineSttWrapper stt;
  sherpaonnx::OnlineSttModelPaths paths;
  const auto r = stt.initializeCustom(
      "not_a_real_model", paths, true, "greedy_search", 4, "", 1.5f, 1, "cpu",
      "", "", 0.f, 0.f, false, false, 2.4f, 0.f, true, 1.4f, 0.f, false, 0.f,
      20.f, "", "");
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(r.error.empty());
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOnlineHost, InitCustomRejectsMissingPaths) {
  sherpaonnx::OnlineSttWrapper stt;
  sherpaonnx::OnlineSttModelPaths paths;
  const auto r = stt.initializeCustom(
      "transducer", paths, true, "greedy_search", 4, "", 1.5f, 1, "cpu", "",
      "", 0.f, 0.f, false, false, 2.4f, 0.f, true, 1.4f, 0.f, false, 0.f, 20.f,
      "", "");
  EXPECT_FALSE(r.success);
  EXPECT_FALSE(stt.isInitialized());
}

sherpaonnx::OnlineSttModelPaths FakeTransducerPaths() {
  sherpaonnx::OnlineSttModelPaths paths;
  paths.encoder = "/nonexistent/encoder.onnx";
  paths.decoder = "/nonexistent/decoder.onnx";
  paths.joiner = "/nonexistent/joiner.onnx";
  paths.tokens = "/nonexistent/tokens.txt";
  return paths;
}

sherpaonnx::OnlineSttInitResult InitFakeTransducer(
    sherpaonnx::OnlineSttWrapper& stt,
    const sherpaonnx::OnlineSttModelPaths& paths,
    const std::string& modelingUnit, const std::string& bpeVocab) {
  return stt.initializeCustom(
      "transducer", paths, true, "modified_beam_search", 4, "", 1.5f, 1,
      "cpu", "", "", 0.f, 0.f, false, false, 2.4f, 0.f, true, 1.4f, 0.f,
      false, 0.f, 20.f, modelingUnit, bpeVocab);
}

TEST(SttOnlineHost, InitCustomRejectsBpeModelingUnitWithoutVocab) {
  sherpaonnx::OnlineSttWrapper stt;
  const auto r = InitFakeTransducer(stt, FakeTransducerPaths(), "bpe", "");
  EXPECT_FALSE(r.success);
  EXPECT_NE(r.error.find("BPE_VOCAB_REQUIRED"), std::string::npos) << r.error;
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOnlineHost, InitCustomRejectsUnknownModelingUnit) {
  sherpaonnx::OnlineSttWrapper stt;
  const auto r = InitFakeTransducer(stt, FakeTransducerPaths(), "phone",
                                    "/nonexistent/bpe.vocab");
  EXPECT_FALSE(r.success);
  EXPECT_NE(r.error.find("INVALID_MODELING_UNIT"), std::string::npos)
      << r.error;
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOnlineHost, InitCustomUsesBpeVocabFromPathsForBpeUnit) {
  // customConfig bpeVocab satisfies the BPE requirement; init then fails
  // later only because the fake model files do not exist.
  sherpaonnx::OnlineSttWrapper stt;
  auto paths = FakeTransducerPaths();
  paths.bpeVocab = "/nonexistent/bpe.vocab";
  const auto r = InitFakeTransducer(stt, paths, "cjkchar+bpe", "");
  EXPECT_FALSE(r.success);
  EXPECT_EQ(r.error.find("BPE_VOCAB_REQUIRED"), std::string::npos) << r.error;
  EXPECT_EQ(r.error.find("INVALID_MODELING_UNIT"), std::string::npos)
      << r.error;
}

// Empty placeholder files: enough for the directory scan, and the missing
// tokens.txt makes sherpa-onnx reject the config before loading any model.
std::filesystem::path MakeFakeTransducerDir(const std::string& name,
                                            bool withBpeVocab) {
  const auto dir = std::filesystem::temp_directory_path() / name;
  std::filesystem::remove_all(dir);
  std::filesystem::create_directories(dir);
  for (const char* f : {"encoder.onnx", "decoder.onnx", "joiner.onnx"}) {
    std::ofstream(dir / f).put('\0');
  }
  if (withBpeVocab) std::ofstream(dir / "bpe.vocab") << "a\t0\n";
  return dir;
}

sherpaonnx::OnlineSttInitResult InitFakeTransducerDir(
    sherpaonnx::OnlineSttWrapper& stt, const std::filesystem::path& dir,
    const std::string& modelingUnit) {
  return stt.initialize(
      dir.string(), "transducer", true, "modified_beam_search", 4, "", 1.5f,
      1, "cpu", "", "", 0.f, 0.f, false, false, 2.4f, 0.f, true, 1.4f, 0.f,
      false, 0.f, 20.f, modelingUnit, "");
}

TEST(SttOnlineHost, InitAutoUsesBpeVocabFoundInModelDir) {
  const auto dir = MakeFakeTransducerDir("sherpa_stt_online_bpe_found", true);
  sherpaonnx::OnlineSttWrapper stt;
  const auto r = InitFakeTransducerDir(stt, dir, "bpe");
  EXPECT_FALSE(r.success);
  EXPECT_EQ(r.error.find("BPE_VOCAB_REQUIRED"), std::string::npos) << r.error;
  std::filesystem::remove_all(dir);
}

TEST(SttOnlineHost, InitAutoRejectsBpeUnitWhenModelDirHasNoVocab) {
  const auto dir =
      MakeFakeTransducerDir("sherpa_stt_online_bpe_missing", false);
  sherpaonnx::OnlineSttWrapper stt;
  const auto r = InitFakeTransducerDir(stt, dir, "bpe");
  EXPECT_FALSE(r.success);
  EXPECT_NE(r.error.find("BPE_VOCAB_REQUIRED"), std::string::npos) << r.error;
  std::filesystem::remove_all(dir);
}

TEST(SttOnlineHost, UnloadSafeWhenUninitialized) {
  sherpaonnx::OnlineSttWrapper stt;
  stt.unload();
  EXPECT_FALSE(stt.isInitialized());
}

TEST(SttOnlineHost, InitStreamDecodeWithRealModel) {
  if (!HostInferenceEnabled()) {
    GTEST_SKIP()
        << "Opt-in inference off (set SHERPA_HOST_INFERENCE=1 to enable)";
  }
  const std::string modelType = EnvOrEmpty("SHERPA_STT_ONLINE_TYPE");
  const std::string tokens = EnvOrEmpty("SHERPA_STT_ONLINE_TOKENS");
  if (modelType.empty() || tokens.empty() || !FileExists(tokens)) {
    GTEST_SKIP() << "Set SHERPA_STT_ONLINE_TYPE + path env vars "
                     "(e.g. SHERPA_STT_ONLINE_TOKENS, "
                     "SHERPA_STT_ONLINE_ENCODER/DECODER/JOINER or "
                     "SHERPA_STT_ONLINE_MODEL for CTC)";
  }

  sherpaonnx::OnlineSttModelPaths paths;
  paths.tokens = tokens;
  paths.encoder = EnvOrEmpty("SHERPA_STT_ONLINE_ENCODER");
  paths.decoder = EnvOrEmpty("SHERPA_STT_ONLINE_DECODER");
  paths.joiner = EnvOrEmpty("SHERPA_STT_ONLINE_JOINER");
  paths.model = EnvOrEmpty("SHERPA_STT_ONLINE_MODEL");

  sherpaonnx::OnlineSttWrapper stt;
  const auto init = stt.initializeCustom(
      modelType, paths, true, "greedy_search", 4, "", 1.5f, 1, "cpu", "", "",
      0.f, 0.f, false, false, 2.4f, 0.f, true, 1.4f, 0.f, false, 0.f, 20.f,
      "", "");
  ASSERT_TRUE(init.success) << init.error;
  ASSERT_TRUE(stt.isInitialized());
  EXPECT_EQ(stt.getSampleRate(), 16000);

  ASSERT_TRUE(stt.createStream("host", ""));
  std::vector<float> silence(1600, 0.f);
  stt.acceptWaveform("host", 16000, silence.data(), silence.size());
  while (stt.isReady("host")) {
    stt.decode("host");
  }
  const auto result = stt.getResult("host");
  (void)result;

  stt.releaseStream("host");
  stt.unload();
  EXPECT_FALSE(stt.isInitialized());
}
