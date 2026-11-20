#include "sherpa-onnx-tts-engine-wrapper.h"
#include "sherpa-onnx-tts-generate-error.h"
#include "sherpa-onnx-tts-lexicon.h"

#include <cstdlib>
#include <fstream>
#include <gtest/gtest.h>
#include <new>
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

TEST(TtsHost, NotInitializedUntilCreate) {
  sherpaonnx::TtsWrapper tts;
  EXPECT_FALSE(tts.isInitialized());
}

TEST(TtsHost, GenerateBeforeInitReturnsEmpty) {
  sherpaonnx::TtsWrapper tts;
  const auto audio = tts.generate("hello", 0, 1.0f);
  EXPECT_TRUE(audio.samples.empty());
}

TEST(TtsHost, GenerateBeforeInitSaysWhy) {
  sherpaonnx::TtsWrapper tts;
  const auto audio = tts.generate("hello", 0, 1.0f);
  EXPECT_EQ(audio.errorCode, sherpaonnx::kTtsErrorGenerate);
  EXPECT_FALSE(audio.errorMessage.empty());

  sherpaonnx::VoiceCloneOptions clone;
  clone.reference_audio = {0.1f, 0.2f};
  clone.reference_sample_rate = 16000;
  clone.reference_text = "hi";
  const auto cloned = tts.generate("hello", 0, 1.0f, clone);
  EXPECT_EQ(cloned.errorCode, sherpaonnx::kTtsErrorGenerate);

  sherpaonnx::TtsWrapper::AudioResult finalAudio;
  finalAudio.sampleRate = 0;
  const bool ok = tts.generateStream(
      "hello", 0, 1.0f,
      [](const float*, int32_t, float) -> int32_t { return 1; }, clone,
      &finalAudio);
  EXPECT_FALSE(ok);
  EXPECT_EQ(finalAudio.errorCode, sherpaonnx::kTtsErrorGenerate);
}

TEST(TtsGenerateError, MapsAllocationFailuresToOom) {
  EXPECT_EQ(sherpaonnx::TtsErrorFromException(std::bad_alloc()).code,
            sherpaonnx::kTtsErrorOom);
  // ONNX Runtime reports allocation failures as Ort::Exception (a std::exception).
  const std::runtime_error ort(
      "Failed to allocate memory for requested buffer of size 123456");
  EXPECT_EQ(sherpaonnx::TtsErrorFromException(ort).code, sherpaonnx::kTtsErrorOom);
  EXPECT_TRUE(sherpaonnx::IsOutOfMemoryText("std::bad_alloc"));
  EXPECT_TRUE(sherpaonnx::IsOutOfMemoryText("CUDA out of memory"));
}

TEST(TtsGenerateError, KeepsOtherExceptionText) {
  const std::runtime_error other("Invalid input shape");
  const auto error = sherpaonnx::TtsErrorFromException(other);
  EXPECT_EQ(error.code, sherpaonnx::kTtsErrorGenerate);
  EXPECT_NE(error.message.find("Invalid input shape"), std::string::npos);
}

TEST(TtsGenerateError, EmptyOutputNamesTheZipvoiceCause) {
  const auto zipvoice =
      sherpaonnx::TtsErrorForEmptyOutput(sherpaonnx::TtsModelKind::kZipvoice);
  EXPECT_EQ(zipvoice.code, sherpaonnx::kTtsErrorEmptyOutput);
  EXPECT_NE(zipvoice.message.find("lexicon"), std::string::npos);
  EXPECT_NE(zipvoice.message.find("too short"), std::string::npos);
  const auto vits =
      sherpaonnx::TtsErrorForEmptyOutput(sherpaonnx::TtsModelKind::kVits);
  EXPECT_EQ(vits.code, sherpaonnx::kTtsErrorEmptyOutput);
  EXPECT_FALSE(vits.message.empty());
}

TEST(TtsLexicon, ZipvoiceLoadsEveryDetectedLexicon) {
  const std::vector<sherpaonnx::model_detect::LexiconCandidate> candidates = {
      {"/m/lexicon.txt", "default"}, {"/m/lexicon-en-us.txt", "en-us"}};
  EXPECT_EQ(sherpaonnx::ResolveTtsLexiconPaths(
                sherpaonnx::TtsModelKind::kZipvoice, candidates),
            "/m/lexicon.txt,/m/lexicon-en-us.txt");
  // An explicit language still picks one file.
  EXPECT_EQ(sherpaonnx::ResolveTtsLexiconPaths(
                sherpaonnx::TtsModelKind::kZipvoice, candidates, "en-us"),
            "/m/lexicon-en-us.txt");
  // Single-lexicon models keep choosing the first file.
  EXPECT_EQ(sherpaonnx::ResolveTtsLexiconPaths(
                sherpaonnx::TtsModelKind::kVits, candidates),
            "/m/lexicon.txt");
  EXPECT_EQ(sherpaonnx::ResolveTtsLexiconPaths(
                sherpaonnx::TtsModelKind::kZipvoice, {}),
            "");
}

TEST(TtsLexicon, ZipvoiceWithoutEnglishLexiconIsRejected) {
  using sherpaonnx::MissingTtsLexiconFile;
  using sherpaonnx::TtsModelKind;
  const std::vector<sherpaonnx::model_detect::LexiconCandidate> chineseOnly = {
      {"/m/lexicon.txt", "default"}};
  // The distilled zh-en pack ships only the Chinese lexicon.
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kZipvoice, chineseOnly),
            "lexicon-en-us.txt");
  // No lexicon at all: upstream fails on text by itself, and tokens still work.
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kZipvoice, {}), "");
  // With the English lexicon next to it nothing is missing.
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kZipvoice,
                                  {{"/m/lexicon.txt", "default"},
                                   {"/m/lexicon-en-us.txt", "en-us"}}),
            "");
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kZipvoice,
                                  {{"/m/lexicon-us-en.txt", "us-en"}}),
            "");
  // An explicit pick is the caller's choice.
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kZipvoice, chineseOnly, "default"), "");
  // Other models load one lexicon and are not checked.
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kVits, chineseOnly), "");
  EXPECT_EQ(MissingTtsLexiconFile(TtsModelKind::kKokoro, {}), "");

  const std::string message = sherpaonnx::TtsLexiconMissingMessage("lexicon-en-us.txt");
  EXPECT_EQ(message.rfind("TTS_LEXICON_MISSING: ", 0), 0u) << message;
  EXPECT_NE(message.find("lexicon-en-us.txt"), std::string::npos);
}

TEST(TtsLexicon, EnglishLexiconLanguageIds) {
  for (const char* id : {"en", "en-us", "EN_gb", "us-en", "gb-en"}) {
    EXPECT_TRUE(sherpaonnx::IsEnglishLexiconLanguageId(id)) << id;
  }
  for (const char* id : {"default", "zh", "ten", "enx", "zh-en-x", ""}) {
    EXPECT_FALSE(sherpaonnx::IsEnglishLexiconLanguageId(id)) << id;
  }
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
