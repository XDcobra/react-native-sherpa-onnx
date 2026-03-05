/**
 * model_detect_test.cpp
 *
 * Host-side GTest suite for STT and TTS model detection. Tests run without real model files:
 * they use path-only fixtures that describe the directory layout of ASR/TTS model assets
 * (e.g. from k2-fsa/sherpa-onnx asr-models and tts-models releases).
 *
 * Fixtures (ASR):
 *   - asr-models-structure.txt, asr-models-expected.csv (see collect-asr-model-structures workflow).
 * Fixtures (TTS):
 *   - tts-models-structure.txt, tts-models-expected.csv (see collect-tts-model-structures workflow).
 *
 * The tests build a FileEntry list from each structure file, call DetectSttModelFromFileList
 * or DetectTtsModelFromFileList (test-only APIs, no filesystem), and assert that the
 * selected model kind matches the expected value from the CSV. Run from repo root so
 * "test/fixtures" resolves, or set TEST_FIXTURES_DIR.
 */

#include "model_detect_test_utils.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-stt.h"
#include "sherpa-onnx-validate-tts.h"

#include <gtest/gtest.h>
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <string>

namespace {

/** Returns the directory containing asr-models-structure.txt and asr-models-expected.csv.
 *  Uses env TEST_FIXTURES_DIR if set, otherwise "test/fixtures" (valid when CWD is repo root). */
std::string GetFixturesDir() {
    const char* env = std::getenv("TEST_FIXTURES_DIR");
    if (env && env[0] != '\0') return std::string(env);
    return "test/fixtures";
}

/**
 * FixturesExist
 *
 * Checks that ASR and TTS fixture files exist and are readable. Fails with a clear
 * error message if any of the structure or CSV files are missing (e.g. wrong working
 * directory or TEST_FIXTURES_DIR). Should run first so later tests do not abort with
 * cryptic parse errors.
 */
TEST(ModelDetectTest, FixturesExist) {
    std::string dir = GetFixturesDir();
    std::ifstream asrStruct(dir + "/asr-models-structure.txt");
    std::ifstream asrCsv(dir + "/asr-models-expected.csv");
    std::ifstream ttsStruct(dir + "/tts-models-structure.txt");
    std::ifstream ttsCsv(dir + "/tts-models-expected.csv");
    ASSERT_TRUE(asrStruct.is_open()) << "Missing: " << dir << "/asr-models-structure.txt";
    ASSERT_TRUE(asrCsv.is_open()) << "Missing: " << dir << "/asr-models-expected.csv";
    ASSERT_TRUE(ttsStruct.is_open()) << "Missing: " << dir << "/tts-models-structure.txt";
    ASSERT_TRUE(ttsCsv.is_open()) << "Missing: " << dir << "/tts-models-expected.csv";
}

/**
 * DetectSttFromFileListMatchesExpected
 *
 * Core test of STT model detection using path fixtures:
 *
 * 1. Loads asr-models-structure.txt and parses the blocks (one block per “# Asset: ...”
 *    with assetName, modelDir, and all path lines). Loads asr-models-expected.csv and
 *    creates a map asset_name -> model_type.
 *
 * 2. For each block for which there is an entry in the CSV:
 *    - If model_type == “unsupported”: Ensures detection does not crash; requires
 *      result.ok == false so initialization is never attempted. When the detector
 *      identifies the model as hardware-specific (RK35xx, Ascend, etc.), also
 *      asserts result.isHardwareSpecificUnsupported == true and non-empty error.
 *    - For known model_type: A FileEntry list is generated from the pathLines
 *      (only file paths, no directory lines). DetectSttModelFromFileList(files, modelDir,
 *      nullopt, “auto”) is called. The test requires result.ok and that result.selectedKind
*      corresponds to the child expected from the CSV (e.g., “paraformer” -> kParaformer,
*      “zipformer” -> kTransducer).
 *
 * Blocks without a CSV entry are skipped. Unknown model_type strings (SttKindFromString
 * returns kUnknown) are also skipped. This allows new assets to appear in the structure file
 * as soon as they have been added to the CSV with a valid or “unsupported” model_type.
 */
TEST(ModelDetectTest, DetectSttFromFileListMatchesExpected) {
    std::string dir = GetFixturesDir();
    std::string structurePath = dir + "/asr-models-structure.txt";
    std::string csvPath = dir + "/asr-models-expected.csv";

    std::string err;
    auto blocks = model_detect_test::ParseAsrStructureFile(structurePath, &err);
    ASSERT_TRUE(err.empty()) << err;
    ASSERT_FALSE(blocks.empty()) << "No asset blocks in " << structurePath;

    auto expectedMap = model_detect_test::ParseAsrExpectedCsv(csvPath, &err);
    ASSERT_TRUE(err.empty()) << err;

    for (const auto& block : blocks) {
        auto it = expectedMap.find(block.assetName);
        if (it == expectedMap.end())
            continue;

        const std::string& expectedType = it->second;
        if (expectedType == "unsupported") {
            auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
            auto result = sherpaonnx::DetectSttModelFromFileList(
                files, block.modelDir, std::nullopt, "auto");
            EXPECT_FALSE(result.ok)
                << "Asset " << block.assetName
                << ": unsupported must not report ok=true so initialization is not attempted.";
            EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(sherpaonnx::SttModelKind::kUnknown))
                << "Asset " << block.assetName
                << ": unsupported must be detected as unknown kind (got " << model_detect_test::SttKindToString(result.selectedKind) << ").";
            if (result.isHardwareSpecificUnsupported) {
                EXPECT_FALSE(result.error.empty())
                    << "Asset " << block.assetName << ": hardware-specific unsupported must return an error message.";
            }
            continue;
        }

        sherpaonnx::SttModelKind expectedKind = model_detect_test::SttKindFromString(expectedType);
        if (expectedKind == sherpaonnx::SttModelKind::kUnknown)
            continue;

        auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
        auto result = sherpaonnx::DetectSttModelFromFileList(
            files, block.modelDir, std::nullopt, "auto");

        ASSERT_TRUE(result.ok) << "Asset " << block.assetName << ": " << result.error;
        EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(expectedKind))
            << "Asset " << block.assetName
            << " expected " << expectedType << " (" << static_cast<int>(expectedKind)
            << ") but got " << model_detect_test::SttKindToString(result.selectedKind)
            << " (" << static_cast<int>(result.selectedKind) << ")";
    }
}

/**
 * DetectTtsFromFileListMatchesExpected
 *
 * TTS counterpart of DetectSttFromFileListMatchesExpected. Loads tts-models-structure.txt
 * and tts-models-expected.csv, builds FileEntry lists per asset block, calls
 * DetectTtsModelFromFileList(files, modelDir, "auto"), and asserts that result.ok is true
 * and result.selectedKind matches the CSV model_type (vits, matcha, kokoro, kitten, pocket,
 * zipvoice). For model_type == "unsupported" asserts result.ok == false and selectedKind == kUnknown.
 * Note: Some TTS types (e.g. vits) require espeak-ng-data in the fixture; otherwise
 * detection may return result.ok == false.
 */
TEST(ModelDetectTest, DetectTtsFromFileListMatchesExpected) {
    std::string dir = GetFixturesDir();
    std::string structurePath = dir + "/tts-models-structure.txt";
    std::string csvPath = dir + "/tts-models-expected.csv";

    std::string err;
    auto blocks = model_detect_test::ParseAsrStructureFile(structurePath, &err);
    ASSERT_TRUE(err.empty()) << err;
    ASSERT_FALSE(blocks.empty()) << "No asset blocks in " << structurePath;

    auto expectedMap = model_detect_test::ParseAsrExpectedCsv(csvPath, &err);
    ASSERT_TRUE(err.empty()) << err;

    for (const auto& block : blocks) {
        auto it = expectedMap.find(block.assetName);
        if (it == expectedMap.end())
            continue;

        const std::string& expectedType = it->second;
        if (expectedType == "unsupported") {
            auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
            auto result = sherpaonnx::DetectTtsModelFromFileList(files, block.modelDir, "auto");
            EXPECT_FALSE(result.ok)
                << "Asset " << block.assetName << ": unsupported must not report ok=true.";
            EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(sherpaonnx::TtsModelKind::kUnknown))
                << "Asset " << block.assetName
                << ": unsupported must be detected as unknown kind (got " << model_detect_test::TtsKindToString(result.selectedKind) << ").";
            continue;
        }

        sherpaonnx::TtsModelKind expectedKind = model_detect_test::TtsKindFromString(expectedType);
        if (expectedKind == sherpaonnx::TtsModelKind::kUnknown)
            continue;

        auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
        auto result = sherpaonnx::DetectTtsModelFromFileList(files, block.modelDir, "auto");

        ASSERT_TRUE(result.ok) << "Asset " << block.assetName << ": " << result.error;
        EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(expectedKind))
            << "Asset " << block.assetName
            << " expected " << expectedType << " (" << static_cast<int>(expectedKind)
            << ") but got " << model_detect_test::TtsKindToString(result.selectedKind)
            << " (" << static_cast<int>(result.selectedKind) << ")";
    }
}

// ============================================================
// Helper: build a synthetic FileEntry from a path string.
// ============================================================

using FE = sherpaonnx::model_detect::FileEntry;

static FE MakeEntry(const std::string& dir, const std::string& name) {
    FE e;
    e.path = dir + "/" + name;
    e.name = name;
    e.nameLower = name;
    std::transform(e.nameLower.begin(), e.nameLower.end(), e.nameLower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    e.size = 1024;
    return e;
}

// ============================================================
// STT validation: missing required files
// ============================================================

TEST(ModelDetectValidation, SttTransducerMissingEncoderRejected) {
    const std::string dir = "test-models/zipformer";
    std::vector<FE> files = {
        MakeEntry(dir, "decoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "joiner-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, std::nullopt, "transducer");
    EXPECT_FALSE(result.ok) << "Should fail when encoder is missing (capability check)";
}

TEST(ModelDetectValidation, SttWhisperMissingTokensValidation) {
    const std::string dir = "test-models/whisper-tiny";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder.onnx"),
        MakeEntry(dir, "decoder.onnx"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, std::nullopt, "whisper");
    EXPECT_FALSE(result.ok) << "Should fail when tokens is missing";
    EXPECT_NE(result.error.find("tokens"), std::string::npos)
        << "Validation error should mention 'tokens': " << result.error;
}

TEST(ModelDetectValidation, SttParaformerMissingTokensValidation) {
    const std::string dir = "test-models/paraformer";
    std::vector<FE> files = {
        MakeEntry(dir, "model.onnx"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, std::nullopt, "paraformer");
    EXPECT_FALSE(result.ok) << "Should fail when tokens is missing for paraformer";
    EXPECT_NE(result.error.find("tokens"), std::string::npos)
        << "Validation error should mention 'tokens': " << result.error;
}

TEST(ModelDetectValidation, SttFireRedMissingTokensValidation) {
    const std::string dir = "test-models/fire-red-asr";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder.onnx"),
        MakeEntry(dir, "decoder.onnx"),
        MakeEntry(dir, "joiner.onnx"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, std::nullopt, "fire_red_asr");
    EXPECT_FALSE(result.ok) << "Should fail when tokens is missing for Fire Red ASR";
    EXPECT_NE(result.error.find("tokens"), std::string::npos)
        << "Validation error should mention 'tokens': " << result.error;
}

TEST(ModelDetectValidation, SttTransducerMissingTokens) {
    const std::string dir = "test-models/zipformer";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "decoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "joiner-epoch-99-avg-1.onnx"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, std::nullopt, "transducer");
    EXPECT_FALSE(result.ok) << "Should fail when tokens.txt is missing";
    EXPECT_NE(result.error.find("tokens"), std::string::npos)
        << "Error should mention 'tokens': " << result.error;
}

// ============================================================
// STT validation: optional fields do NOT cause failure
// ============================================================

TEST(ModelDetectValidation, SttTransducerOptionalBpeVocab) {
    const std::string dir = "test-models/zipformer";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "decoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "joiner-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, std::nullopt, "transducer");
    EXPECT_TRUE(result.ok) << "Should succeed without optional bpeVocab: " << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kTransducer);
}

// ============================================================
// TTS validation: missing required files
// ============================================================

TEST(ModelDetectValidation, TtsKokoroMissingEspeakData) {
    const std::string dir = "test-models/kokoro-v1.0";
    std::vector<FE> files = {
        MakeEntry(dir, "model.onnx"),
        MakeEntry(dir, "tokens.txt"),
        MakeEntry(dir, "voices.bin"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "kokoro");
    EXPECT_FALSE(result.ok) << "Should fail when espeak-ng-data is missing";
    EXPECT_NE(result.error.find("dataDir"), std::string::npos)
        << "Error should mention 'dataDir': " << result.error;
    EXPECT_NE(result.error.find("espeak-ng-data"), std::string::npos)
        << "Error should include hint about espeak-ng-data: " << result.error;
}

TEST(ModelDetectValidation, TtsKokoroMissingVoices) {
    const std::string dir = "test-models/kokoro-v1.0";
    std::vector<FE> files = {
        MakeEntry(dir, "model.onnx"),
        MakeEntry(dir, "tokens.txt"),
        MakeEntry(dir + "/espeak-ng-data", "phontab"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "kokoro");
    EXPECT_FALSE(result.ok) << "Should fail when voices.bin is missing";
    EXPECT_NE(result.error.find("voices"), std::string::npos)
        << "Error should mention 'voices': " << result.error;
}

TEST(ModelDetectValidation, TtsVitsMissingModel) {
    const std::string dir = "test-models/vits-piper";
    std::vector<FE> files = {
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "vits");
    EXPECT_FALSE(result.ok) << "Should fail when ttsModel is missing";
    EXPECT_NE(result.error.find("ttsModel"), std::string::npos)
        << "Error should mention 'ttsModel': " << result.error;
}

TEST(ModelDetectValidation, TtsPocketMissingTextConditioner) {
    const std::string dir = "test-models/pocket-tts";
    std::vector<FE> files = {
        MakeEntry(dir, "lm_flow.onnx"),
        MakeEntry(dir, "lm_main.onnx"),
        MakeEntry(dir, "encoder.onnx"),
        MakeEntry(dir, "decoder.onnx"),
        MakeEntry(dir, "vocab.json"),
        MakeEntry(dir, "token_scores.json"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "pocket");
    EXPECT_FALSE(result.ok) << "Should fail when textConditioner is missing";
    EXPECT_NE(result.error.find("textConditioner"), std::string::npos)
        << "Error should mention 'textConditioner': " << result.error;
}

// ============================================================
// TTS validation: optional fields do NOT cause failure
// ============================================================

TEST(ModelDetectValidation, TtsVitsOptionalDataDir) {
    const std::string dir = "test-models/vits-piper";
    std::vector<FE> files = {
        MakeEntry(dir, "model.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "vits");
    EXPECT_TRUE(result.ok) << "Should succeed without optional dataDir: " << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::TtsModelKind::kVits);
}

TEST(ModelDetectValidation, TtsMatchaOptionalLexicon) {
    const std::string dir = "test-models/matcha-tts";
    std::vector<FE> files = {
        MakeEntry(dir, "acoustic-model.onnx"),
        MakeEntry(dir, "vocoder.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "matcha");
    EXPECT_TRUE(result.ok) << "Should succeed without optional lexicon: " << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::TtsModelKind::kMatcha);
}

// ============================================================
// Direct validation function unit tests
// ============================================================

TEST(ModelDetectValidation, ValidateSttPathsDirectOk) {
    sherpaonnx::SttModelPaths paths;
    paths.encoder = "/m/encoder.onnx";
    paths.decoder = "/m/decoder.onnx";
    paths.joiner = "/m/joiner.onnx";
    paths.tokens = "/m/tokens.txt";
    auto v = sherpaonnx::ValidateSttPaths(sherpaonnx::SttModelKind::kTransducer, paths, "/m");
    EXPECT_TRUE(v.ok);
    EXPECT_TRUE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateSttPathsDirectMissing) {
    sherpaonnx::SttModelPaths paths;
    paths.encoder = "/m/encoder.onnx";
    paths.decoder = "/m/decoder.onnx";
    auto v = sherpaonnx::ValidateSttPaths(sherpaonnx::SttModelKind::kTransducer, paths, "/m");
    EXPECT_FALSE(v.ok);
    EXPECT_EQ(v.missingRequired.size(), 2u);
    EXPECT_NE(std::find(v.missingRequired.begin(), v.missingRequired.end(), "joiner"),
              v.missingRequired.end());
    EXPECT_NE(std::find(v.missingRequired.begin(), v.missingRequired.end(), "tokens"),
              v.missingRequired.end());
}

TEST(ModelDetectValidation, ValidateTtsPathsDirectOk) {
    sherpaonnx::TtsModelPaths paths;
    paths.ttsModel = "/m/model.onnx";
    paths.tokens = "/m/tokens.txt";
    paths.voices = "/m/voices.bin";
    paths.dataDir = "/m/espeak-ng-data";
    auto v = sherpaonnx::ValidateTtsPaths(sherpaonnx::TtsModelKind::kKokoro, paths, "/m");
    EXPECT_TRUE(v.ok);
    EXPECT_TRUE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateTtsPathsDirectMissing) {
    sherpaonnx::TtsModelPaths paths;
    paths.ttsModel = "/m/model.onnx";
    auto v = sherpaonnx::ValidateTtsPaths(sherpaonnx::TtsModelKind::kKokoro, paths, "/m");
    EXPECT_FALSE(v.ok);
    EXPECT_EQ(v.missingRequired.size(), 3u);
    EXPECT_NE(std::find(v.missingRequired.begin(), v.missingRequired.end(), "tokens"),
              v.missingRequired.end());
    EXPECT_NE(std::find(v.missingRequired.begin(), v.missingRequired.end(), "voices"),
              v.missingRequired.end());
    EXPECT_NE(std::find(v.missingRequired.begin(), v.missingRequired.end(), "dataDir"),
              v.missingRequired.end());
}

TEST(ModelDetectValidation, ValidateTtsPathsUnknownKindPassesThrough) {
    sherpaonnx::TtsModelPaths paths;
    auto v = sherpaonnx::ValidateTtsPaths(sherpaonnx::TtsModelKind::kUnknown, paths, "/m");
    EXPECT_TRUE(v.ok) << "Unknown kind should not fail validation";
}

TEST(ModelDetectValidation, ValidateSttPathsUnknownKindPassesThrough) {
    sherpaonnx::SttModelPaths paths;
    auto v = sherpaonnx::ValidateSttPaths(sherpaonnx::SttModelKind::kUnknown, paths, "/m");
    EXPECT_TRUE(v.ok) << "Unknown kind should not fail validation";
}

}  // namespace
