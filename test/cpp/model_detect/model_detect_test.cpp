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
 * Fixtures (speech enhancement):
 *   - speech-enhancement-models-structure.txt, speech-enhancement-models-expected.csv
 *     (see collect-speech-enhancement-model-structures workflow).
 * Fixtures (VAD):
 *   - asr-models-structure.txt + vad-models-expected.csv (VAD assets live in asr-models release).
 *
 * The tests build a FileEntry list from each structure file, call DetectSttModelFromFileList
 * or DetectTtsModelFromFileList (test-only APIs, no filesystem), and assert outcomes per CSV
 * (including full detect+validate for TTS: see DetectTtsFromFileListMatchesExpected). Run from
 * repo root so "test/fixtures" resolves, or set TEST_FIXTURES_DIR.
 */

#include "model_detect_test_utils.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-unified.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-stt.h"
#include "sherpa-onnx-validate-online-stt.h"
#include "sherpa-onnx-validate-tts.h"
#include "sherpa-onnx-validate-enhancement.h"
#include "sherpa-onnx-validate-vad.h"
#include "sherpa-onnx-validate-custom.h"
#include "sherpa-onnx-model-path-fill.h"

#include <gtest/gtest.h>
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <map>
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
    std::ifstream enhStruct(dir + "/speech-enhancement-models-structure.txt");
    std::ifstream enhCsv(dir + "/speech-enhancement-models-expected.csv");
    std::ifstream vadCsv(dir + "/vad-models-expected.csv");
    ASSERT_TRUE(asrStruct.is_open()) << "Missing: " << dir << "/asr-models-structure.txt";
    ASSERT_TRUE(asrCsv.is_open()) << "Missing: " << dir << "/asr-models-expected.csv";
    ASSERT_TRUE(ttsStruct.is_open()) << "Missing: " << dir << "/tts-models-structure.txt";
    ASSERT_TRUE(ttsCsv.is_open()) << "Missing: " << dir << "/tts-models-expected.csv";
    ASSERT_TRUE(enhStruct.is_open()) << "Missing: " << dir << "/speech-enhancement-models-structure.txt";
    ASSERT_TRUE(enhCsv.is_open()) << "Missing: " << dir << "/speech-enhancement-models-expected.csv";
    ASSERT_TRUE(vadCsv.is_open()) << "Missing: " << dir << "/vad-models-expected.csv";
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
                files, block.modelDir, "auto", std::nullopt);
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
            files, block.modelDir, "auto", std::nullopt);

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
 * DetectTtsModelFromFileList(files, modelDir, "auto"), and asserts the outcome matches the CSV:
 *
 * - Known types (vits, matcha, kokoro, kitten, pocket, zipvoice): result.ok == true and
 *   selectedKind matches. This is the full pipeline (detect + ValidateTtsPaths): ok means the
 *   layout is sufficient for native init, not merely “looks like” a type.
 * - model_type == "unsupported": not init-ready / unknown kind; result.ok == false and
 *   selectedKind == kUnknown (e.g. hardware-specific or non-model assets).
 * - model_type == "zipvoice_rejected": classified as Zipvoice but ValidateTtsPaths fails on the
 *   real release file list (e.g. missing lexicon.txt, or distill-only layout without vocoder).
 *   Expects ok == false, non-empty error, selectedKind still kZipvoice.
 *
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

        if (expectedType == "zipvoice_rejected") {
            auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
            auto result = sherpaonnx::DetectTtsModelFromFileList(files, block.modelDir, "auto");
            EXPECT_FALSE(result.ok)
                << "Asset " << block.assetName
                << ": Zipvoice layout from release must be rejected when required files are missing: "
                << result.error;
            EXPECT_FALSE(result.error.empty())
                << "Asset " << block.assetName << ": rejection must include an error message.";
            EXPECT_EQ(static_cast<int>(result.selectedKind),
                      static_cast<int>(sherpaonnx::TtsModelKind::kZipvoice))
                << "Asset " << block.assetName
                << ": expected kZipvoice before validation failure (got "
                << model_detect_test::TtsKindToString(result.selectedKind) << ").";
            std::string errLower = result.error;
            std::transform(errLower.begin(), errLower.end(), errLower.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            EXPECT_NE(errLower.find("zipvoice"), std::string::npos)
                << "Asset " << block.assetName << ": expected Zipvoice context in error, got: " << result.error;
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

/**
 * DetectEnhancementFromFileListMatchesExpected
 *
 * Loads speech-enhancement-models-structure.txt and speech-enhancement-models-expected.csv
 * (k2-fsa/sherpa-onnx speech-enhancement-models release). Each asset is typically a single .onnx;
 * fixtures use model dir "." and path ./<basename>.onnx.
 */
TEST(ModelDetectTest, DetectEnhancementFromFileListMatchesExpected) {
    std::string dir = GetFixturesDir();
    std::string structurePath = dir + "/speech-enhancement-models-structure.txt";
    std::string csvPath = dir + "/speech-enhancement-models-expected.csv";

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
            auto result = sherpaonnx::DetectEnhancementModelFromFileList(files, block.modelDir, "auto");
            EXPECT_FALSE(result.ok)
                << "Asset " << block.assetName << ": unsupported must not report ok=true.";
            EXPECT_EQ(static_cast<int>(result.selectedKind),
                      static_cast<int>(sherpaonnx::EnhancementModelKind::kUnknown))
                << "Asset " << block.assetName;
            continue;
        }

        sherpaonnx::EnhancementModelKind expectedKind = model_detect_test::EnhancementKindFromString(expectedType);
        if (expectedKind == sherpaonnx::EnhancementModelKind::kUnknown)
            continue;

        auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
        auto result = sherpaonnx::DetectEnhancementModelFromFileList(files, block.modelDir, "auto");

        ASSERT_TRUE(result.ok) << "Asset " << block.assetName << ": " << result.error;
        EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(expectedKind))
            << "Asset " << block.assetName
            << " expected " << expectedType << " (" << static_cast<int>(expectedKind)
            << ") but got " << model_detect_test::EnhancementKindToString(result.selectedKind)
            << " (" << static_cast<int>(result.selectedKind) << ")";
    }
}

TEST(ModelDetectTest, DetectPunctuationFromFileListMatchesExpected) {
    std::string dir = GetFixturesDir();
    std::string structurePath = dir + "/punctuation-models-structure.txt";
    std::string csvPath = dir + "/punctuation-models-expected.csv";

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
        sherpaonnx::PunctuationModelKind expectedKind = model_detect_test::PunctuationKindFromString(
            expectedType
        );
        if (expectedKind == sherpaonnx::PunctuationModelKind::kUnknown)
            continue;

        auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
        auto result = sherpaonnx::DetectPunctuationModelFromFileList(files, block.modelDir, "auto");

        ASSERT_TRUE(result.ok) << "Asset " << block.assetName << ": " << result.error;
        EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(expectedKind))
            << "Asset " << block.assetName
            << " expected " << expectedType
            << " but got " << model_detect_test::PunctuationKindToString(result.selectedKind);
        if (expectedType == "cnn_bilstm") {
            EXPECT_TRUE(result.isStreaming)
                << "Asset " << block.assetName << " should report streaming (online) compatibility";
        } else if (expectedType == "ct_transformer") {
            EXPECT_FALSE(result.isStreaming) << "Asset " << block.assetName << " is offline CT";
        }
    }
}

TEST(ModelDetectTest, DetectVadFromAsrFileListMatchesExpected) {
    std::string dir = GetFixturesDir();
    std::string structurePath = dir + "/asr-models-structure.txt";
    std::string csvPath = dir + "/vad-models-expected.csv";

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
            auto result = sherpaonnx::DetectVadModelFromFileList(files, block.modelDir, "auto");
            EXPECT_FALSE(result.ok)
                << "Asset " << block.assetName << ": unsupported must not report ok=true.";
            EXPECT_EQ(static_cast<int>(result.selectedKind),
                      static_cast<int>(sherpaonnx::VadModelKind::kUnknown))
                << "Asset " << block.assetName;
            continue;
        }

        sherpaonnx::VadModelKind expectedKind = model_detect_test::VadKindFromString(expectedType);
        if (expectedKind == sherpaonnx::VadModelKind::kUnknown)
            continue;

        auto files = model_detect_test::BuildFileEntriesFromPathLines(block.modelDir, block.pathLines);
        auto result = sherpaonnx::DetectVadModelFromFileList(files, block.modelDir, "auto");

        ASSERT_TRUE(result.ok) << "Asset " << block.assetName << ": " << result.error;
        EXPECT_EQ(static_cast<int>(result.selectedKind), static_cast<int>(expectedKind))
            << "Asset " << block.assetName
            << " expected " << expectedType << " (" << static_cast<int>(expectedKind)
            << ") but got " << model_detect_test::VadKindToString(result.selectedKind)
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
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "transducer", std::nullopt);
    EXPECT_FALSE(result.ok) << "Should fail when encoder is missing (capability check)";
}

TEST(ModelDetectValidation, SttWhisperMissingTokensValidation) {
    const std::string dir = "test-models/whisper-tiny";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder.onnx"),
        MakeEntry(dir, "decoder.onnx"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "whisper", std::nullopt);
    EXPECT_FALSE(result.ok) << "Should fail when tokens is missing";
    EXPECT_NE(result.error.find("tokens"), std::string::npos)
        << "Validation error should mention 'tokens': " << result.error;
}

TEST(ModelDetectValidation, SttParaformerMissingTokensValidation) {
    const std::string dir = "test-models/paraformer";
    std::vector<FE> files = {
        MakeEntry(dir, "model.onnx"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "paraformer", std::nullopt);
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
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "fire_red_asr", std::nullopt);
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
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "transducer", std::nullopt);
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
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "transducer", std::nullopt);
    EXPECT_TRUE(result.ok) << "Should succeed without optional bpeVocab: " << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kTransducer);
}

TEST(ModelDetectValidation, SttNameOnlyEmptyFilesAutoUsesDirName) {
    std::vector<FE> files;
    const std::string dir = "test-models/sherpa-onnx-whisper-tiny-en";
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "auto", std::nullopt);
    EXPECT_FALSE(result.ok) << "Name-only mode must not validate without a file listing";
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kWhisper);
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kNameOnly),
              result.detectionSources.end());
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kDirName),
              result.detectionSources.end());
}

TEST(ModelDetectValidation, SttNameOnlyEmptyFilesExplicit) {
    std::vector<FE> files;
    const std::string dir = "test-models/some-asr-model";
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "paraformer", std::nullopt);
    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kParaformer);
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kNameOnly),
              result.detectionSources.end());
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kExplicitModelType),
              result.detectionSources.end());
}

TEST(ModelDetectValidation, SttFullScanDetectionSourcesExplicit) {
    const std::string dir = "test-models/zipformer";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "decoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "joiner-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "transducer", std::nullopt);
    EXPECT_TRUE(result.ok) << result.error;
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kFileListing),
              result.detectionSources.end());
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kExplicitModelType),
              result.detectionSources.end());
}

// ═══ STT isStreaming (online-guard) ═════════════════════════════════════

TEST(SttIsStreaming, NameOnlyStreamingTransducer) {
    const std::string syntheticDir = "m/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
    auto result = sherpaonnx::DetectSttModelFromFileList({}, syntheticDir, "auto", std::nullopt);

    EXPECT_FALSE(result.ok) << "Name-only detection should not be fully successful";
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kTransducer);
    EXPECT_TRUE(result.isStreaming)
        << "Name-only transducer should be heuristically marked streaming";
}

TEST(SttIsStreaming, NameOnlyStreamingParaformer) {
    const std::string syntheticDir = "m/sherpa-onnx-streaming-paraformer-bilingual-zh-en";
    auto result = sherpaonnx::DetectSttModelFromFileList({}, syntheticDir, "auto", std::nullopt);

    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kParaformer);
    EXPECT_TRUE(result.isStreaming)
        << "Name-only paraformer should be heuristically marked streaming";
}

TEST(SttIsStreaming, NameOnlyNonStreamingWhisper) {
    const std::string syntheticDir = "m/sherpa-onnx-whisper-tiny";
    auto result = sherpaonnx::DetectSttModelFromFileList({}, syntheticDir, "auto", std::nullopt);

    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kWhisper);
    EXPECT_FALSE(result.isStreaming)
        << "Whisper is offline-only; should not be streaming";
}

TEST(SttIsStreaming, NameOnlyNonStreamingSenseVoice) {
    const std::string syntheticDir = "m/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
    auto result = sherpaonnx::DetectSttModelFromFileList({}, syntheticDir, "auto", std::nullopt);

    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kSenseVoice);
    EXPECT_FALSE(result.isStreaming)
        << "SenseVoice is offline-only; should not be streaming";
}

TEST(SttIsStreaming, NameOnlyExplicitWenetCtcIsStreaming) {
    const std::string syntheticDir = "m/sherpa-onnx-streaming-wenet-ctc-aishell";
    auto result = sherpaonnx::DetectSttModelFromFileList({}, syntheticDir, "wenet_ctc", std::nullopt);

    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kWenetCtc);
    EXPECT_TRUE(result.isStreaming)
        << "WeNet CTC (explicit type) should be heuristically marked streaming";
}

TEST(SttIsStreaming, FileListTransducerIsStreamingWithoutOrt) {
    // In test builds ORT is not available, so the guard optimistically returns passed=true.
    const std::string dir = "test-models/streaming-transducer";
    std::vector<FE> files = {
        MakeEntry(dir, "encoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "decoder-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "joiner-epoch-99-avg-1.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "transducer", std::nullopt);
    EXPECT_TRUE(result.ok) << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kTransducer);
    // Without ORT the guard optimistically returns true
    EXPECT_TRUE(result.isStreaming);
}

TEST(SttIsStreaming, FileListWhisperIsNotStreaming) {
    const std::string dir = "test-models/whisper-tiny";
    std::vector<FE> files = {
        MakeEntry(dir, "tiny-encoder.onnx"),
        MakeEntry(dir, "tiny-decoder.onnx"),
        MakeEntry(dir, "tiny-tokens.txt"),
    };
    auto result = sherpaonnx::DetectSttModelFromFileList(files, dir, "whisper", std::nullopt);
    EXPECT_TRUE(result.ok) << result.error;
    EXPECT_EQ(result.selectedKind, sherpaonnx::SttModelKind::kWhisper);
    EXPECT_FALSE(result.isStreaming)
        << "Whisper file-list detection should not be streaming";
}


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

TEST(ModelDetectValidation, TtsNameOnlyEmptyFilesAutoUsesDirName) {
    std::vector<FE> files;
    const std::string dir = "test-models/vits-piper";
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "auto");
    EXPECT_FALSE(result.ok) << "Name-only mode must not validate without a file listing";
    EXPECT_EQ(result.selectedKind, sherpaonnx::TtsModelKind::kVits);
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kNameOnly),
              result.detectionSources.end());
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kDirName),
              result.detectionSources.end());
}

TEST(ModelDetectValidation, TtsNameOnlyEmptyFilesExplicit) {
    std::vector<FE> files;
    const std::string dir = "test-models/vits-piper";
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "matcha");
    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::TtsModelKind::kMatcha);
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kNameOnly),
              result.detectionSources.end());
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kExplicitModelType),
              result.detectionSources.end());
}

TEST(ModelDetectValidation, TtsNameOnlyEmptyFilesNoHintInName) {
    std::vector<FE> files;
    const std::string dir = "test-models/unknown-folder";
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "auto");
    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, sherpaonnx::TtsModelKind::kUnknown);
    EXPECT_FALSE(result.error.empty());
}

TEST(ModelDetectValidation, TtsFullScanDetectionSourcesExplicit) {
    const std::string dir = "test-models/vits-piper";
    std::vector<FE> files = {
        MakeEntry(dir, "model.onnx"),
        MakeEntry(dir, "tokens.txt"),
    };
    auto result = sherpaonnx::DetectTtsModelFromFileList(files, dir, "vits");
    EXPECT_TRUE(result.ok) << result.error;
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kFileListing),
              result.detectionSources.end());
    EXPECT_NE(std::find(result.detectionSources.begin(), result.detectionSources.end(),
                        sherpaonnx::DetectionSource::kExplicitModelType),
              result.detectionSources.end());
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

TEST(ModelDetectValidation, ValidateOnlineSttPathsDirectOk) {
    sherpaonnx::OnlineSttModelPaths paths;
    paths.encoder = "/m/encoder.onnx";
    paths.decoder = "/m/decoder.onnx";
    paths.joiner = "/m/joiner.onnx";
    paths.tokens = "/m/tokens.txt";
    auto v = sherpaonnx::ValidateOnlineSttPaths(
        sherpaonnx::OnlineSttModelKind::kTransducer, paths, "/m");
    EXPECT_TRUE(v.ok);
    EXPECT_TRUE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateOnlineSttPathsDirectMissing) {
    sherpaonnx::OnlineSttModelPaths paths;
    paths.encoder = "/m/encoder.onnx";
    auto v = sherpaonnx::ValidateOnlineSttPaths(
        sherpaonnx::OnlineSttModelKind::kTransducer, paths, "/m");
    EXPECT_FALSE(v.ok);
    EXPECT_FALSE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateOnlineSttPathsUnknownKindPassesThrough) {
    sherpaonnx::OnlineSttModelPaths paths;
    auto v = sherpaonnx::ValidateOnlineSttPaths(
        sherpaonnx::OnlineSttModelKind::kUnknown, paths, "/m");
    EXPECT_TRUE(v.ok) << "Unknown kind should not fail validation";
}

TEST(ModelDetectValidation, ValidateEnhancementPathsDirectOk) {
    sherpaonnx::EnhancementModelPaths paths;
    paths.model = "/m/gtcrn_simple.onnx";
    auto v = sherpaonnx::ValidateEnhancementPaths(
        sherpaonnx::EnhancementModelKind::kGtcrn, paths, "/m");
    EXPECT_TRUE(v.ok);
    EXPECT_TRUE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateEnhancementPathsDirectMissingModel) {
    sherpaonnx::EnhancementModelPaths paths;
    auto v = sherpaonnx::ValidateEnhancementPaths(
        sherpaonnx::EnhancementModelKind::kDpdfNet, paths, "/m");
    EXPECT_FALSE(v.ok);
    EXPECT_FALSE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateEnhancementPathsUnknownKindPassesThrough) {
    sherpaonnx::EnhancementModelPaths paths;
    auto v = sherpaonnx::ValidateEnhancementPaths(
        sherpaonnx::EnhancementModelKind::kUnknown, paths, "/m");
    EXPECT_TRUE(v.ok) << "Unknown kind should not fail validation";
}

TEST(ModelDetectValidation, ValidateVadPathsDirectOk) {
    sherpaonnx::VadModelPaths paths;
    paths.model = "/m/silero_vad.onnx";
    auto v = sherpaonnx::ValidateVadPaths(
        sherpaonnx::VadModelKind::kSileroVad, paths, "/m");
    EXPECT_TRUE(v.ok);
    EXPECT_TRUE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateVadPathsDirectMissingModel) {
    sherpaonnx::VadModelPaths paths;
    auto v = sherpaonnx::ValidateVadPaths(
        sherpaonnx::VadModelKind::kTenVad, paths, "/m");
    EXPECT_FALSE(v.ok);
    EXPECT_FALSE(v.missingRequired.empty());
}

TEST(ModelDetectValidation, ValidateVadPathsUnknownKindPassesThrough) {
    sherpaonnx::VadModelPaths paths;
    auto v = sherpaonnx::ValidateVadPaths(
        sherpaonnx::VadModelKind::kUnknown, paths, "/m");
    EXPECT_TRUE(v.ok) << "Unknown kind should not fail validation";
}

TEST(ModelDetectValidation, EnhancementMissingOnnxRejected) {
    const std::string dir = "test-models/enhancement-empty";
    std::vector<FE> files = {
        MakeEntry(dir, "readme.txt"),
    };
    auto result = sherpaonnx::DetectEnhancementModelFromFileList(files, dir, "auto");
    EXPECT_FALSE(result.ok) << "Should fail when no gtcrn/dpdfnet onnx is present";
    EXPECT_FALSE(result.isStreaming);
}

TEST(ModelDetectValidation, EnhancementNameOnlyGtcrnIsHeuristicStreaming) {
    const std::string syntheticDir = "m/sherpa-onnx-speech-enhancement-gtcrn";
    auto result = sherpaonnx::DetectEnhancementModelFromFileList({}, syntheticDir, "auto");

    EXPECT_FALSE(result.ok) << "Name-only detection must remain heuristic and not fully successful";
    EXPECT_TRUE(result.isStreaming) << "Name-only gtcrn should be marked streaming as best effort";
    EXPECT_EQ(static_cast<int>(result.selectedKind),
              static_cast<int>(sherpaonnx::EnhancementModelKind::kGtcrn));
    EXPECT_NE(result.error.find("heuristic"), std::string::npos)
        << "Expected heuristic note in error: " << result.error;
}

TEST(ModelDetectValidation, EnhancementNameOnlyUnknownIsNotStreaming) {
    const std::string syntheticDir = "m/some-random-enhancement-model";
    auto result = sherpaonnx::DetectEnhancementModelFromFileList({}, syntheticDir, "auto");

    EXPECT_FALSE(result.ok);
    EXPECT_FALSE(result.isStreaming);
    EXPECT_EQ(static_cast<int>(result.selectedKind),
              static_cast<int>(sherpaonnx::EnhancementModelKind::kUnknown));
}

TEST(ModelDetectValidation, EnhancementFileListGtcrnMarksStreaming) {
    const std::string dir = "test-models/enhancement-gtcrn";
    std::vector<FE> files = {
        MakeEntry(dir, "speech-enhancement-gtcrn.onnx"),
    };
    auto result = sherpaonnx::DetectEnhancementModelFromFileList(files, dir, "auto");

    EXPECT_TRUE(result.ok) << result.error;
    EXPECT_TRUE(result.isStreaming);
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttTransducerOk) {
    std::map<std::string, std::string> paths = {
        {"encoder", "/e.onnx"},
        {"decoder", "/d.onnx"},
        {"joiner", "/j.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "transducer", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttTransducerMissingJoiner) {
    std::map<std::string, std::string> paths = {
        {"encoder", "/e.onnx"},
        {"decoder", "/d.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "transducer", paths, "custom");
    EXPECT_FALSE(result.ok);
    ASSERT_FALSE(result.missingRequired.empty());
    EXPECT_EQ(result.missingRequired[0], "joiner");
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttParaformerOfflineOk) {
    std::map<std::string, std::string> paths = {
        {"paraformerModel", "/p.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "paraformer", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttParaformerStreamingOk) {
    std::map<std::string, std::string> paths = {
        {"encoder", "/e.onnx"},
        {"decoder", "/d.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths(
        "stt_streaming", "paraformer", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttParaformerOfflineRejectsStreamingLayout) {
    std::map<std::string, std::string> paths = {
        {"encoder", "/e.onnx"},
        {"decoder", "/d.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "paraformer", paths, "custom");
    EXPECT_FALSE(result.ok);
    ASSERT_FALSE(result.missingRequired.empty());
    EXPECT_EQ(result.missingRequired[0], "paraformerModel");
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttParaformerMissingLayout) {
    std::map<std::string, std::string> paths = {
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "paraformer", paths, "custom");
    EXPECT_FALSE(result.ok);
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttMoonshineV2Ok) {
    std::map<std::string, std::string> paths = {
        {"moonshineEncoder", "/e.onnx"},
        {"moonshineMergedDecoder", "/d.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "moonshine_v2", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsSttMoonshineV1Distinct) {
    std::map<std::string, std::string> paths = {
        {"moonshineEncoder", "/e.onnx"},
        {"moonshineMergedDecoder", "/d.onnx"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("stt", "moonshine", paths, "custom");
    EXPECT_FALSE(result.ok);
}

TEST(ModelDetectValidation, ValidateCustomModelPathsTtsSmoke) {
    std::map<std::string, std::string> paths = {
        {"ttsModel", "/m.onnx"},
        {"tokens", "/tokens.txt"},
    };
    auto result = sherpaonnx::ValidateCustomModelPaths("tts", "vits", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsVadSmoke) {
    std::map<std::string, std::string> paths = {{"model", "/vad.onnx"}};
    auto result = sherpaonnx::ValidateCustomModelPaths("vad", "silero_vad", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsEnhancementSmoke) {
    std::map<std::string, std::string> paths = {{"model", "/gtcrn.onnx"}};
    auto result = sherpaonnx::ValidateCustomModelPaths("enhancement", "gtcrn", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsPunctuationSmoke) {
    std::map<std::string, std::string> paths = {{"ct_transformer", "/p.onnx"}};
    auto result = sherpaonnx::ValidateCustomModelPaths(
        "punctuation", "ct_transformer", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, ValidateCustomModelPathsAlignmentSmoke) {
    std::map<std::string, std::string> paths = {{"model", "/a.onnx"}};
    auto result = sherpaonnx::ValidateCustomModelPaths("alignment", "wav2vec2", paths, "custom");
    EXPECT_TRUE(result.ok) << result.error;
}

TEST(ModelDetectValidation, GetCustomModelPathRequirementsSttParaformerOffline) {
    auto reqs = sherpaonnx::GetCustomModelPathRequirements("stt", "paraformer");
    auto findField = [&reqs](const char* key) {
        return std::find_if(
            reqs.fields.begin(),
            reqs.fields.end(),
            [key](const sherpaonnx::CustomPathFieldSpec& field) {
                return field.key == key;
            });
    };
    auto paraformerModel = findField("paraformerModel");
    ASSERT_NE(paraformerModel, reqs.fields.end());
    EXPECT_TRUE(paraformerModel->required);
    auto tokens = findField("tokens");
    ASSERT_NE(tokens, reqs.fields.end());
    EXPECT_TRUE(tokens->required);
    EXPECT_EQ(findField("encoder"), reqs.fields.end());
    EXPECT_EQ(findField("decoder"), reqs.fields.end());
}

TEST(ModelDetectValidation, GetCustomModelPathRequirementsSttStreamingParaformer) {
    auto reqs = sherpaonnx::GetCustomModelPathRequirements("stt_streaming", "paraformer");
    auto findField = [&reqs](const char* key) {
        return std::find_if(
            reqs.fields.begin(),
            reqs.fields.end(),
            [key](const sherpaonnx::CustomPathFieldSpec& field) {
                return field.key == key;
            });
    };
    for (const char* key : {"encoder", "decoder", "tokens"}) {
        auto field = findField(key);
        ASSERT_NE(field, reqs.fields.end()) << key;
        EXPECT_TRUE(field->required) << key;
    }
    EXPECT_EQ(findField("paraformerModel"), reqs.fields.end());
}

TEST(ModelDetectValidation, GetCustomModelPathRequirementsSttTransducer) {
    auto reqs = sherpaonnx::GetCustomModelPathRequirements("stt", "transducer");
    auto hasKey = [&reqs](const char* key) {
        return std::any_of(
            reqs.fields.begin(),
            reqs.fields.end(),
            [key](const sherpaonnx::CustomPathFieldSpec& field) {
                return field.key == key;
            });
    };
    EXPECT_TRUE(hasKey("encoder"));
    EXPECT_TRUE(hasKey("joiner"));
    auto bpe = std::find_if(
        reqs.fields.begin(),
        reqs.fields.end(),
        [](const sherpaonnx::CustomPathFieldSpec& field) {
            return field.key == "bpeVocab";
        });
    ASSERT_NE(bpe, reqs.fields.end());
    EXPECT_FALSE(bpe->required);
    for (const auto& field : reqs.fields) {
        EXPECT_FALSE(field.isDirectory) << field.key;
    }
}

TEST(ModelDetectValidation, GetCustomModelPathRequirementsTtsVitsDataDirIsDirectory) {
    auto reqs = sherpaonnx::GetCustomModelPathRequirements("tts", "vits");
    ASSERT_FALSE(reqs.fields.empty());
    auto dataDir = std::find_if(
        reqs.fields.begin(),
        reqs.fields.end(),
        [](const sherpaonnx::CustomPathFieldSpec& field) {
            return field.key == "dataDir";
        });
    ASSERT_NE(dataDir, reqs.fields.end());
    EXPECT_FALSE(dataDir->required);
    EXPECT_TRUE(dataDir->isDirectory);
    auto ttsModel = std::find_if(
        reqs.fields.begin(),
        reqs.fields.end(),
        [](const sherpaonnx::CustomPathFieldSpec& field) {
            return field.key == "ttsModel";
        });
    ASSERT_NE(ttsModel, reqs.fields.end());
    EXPECT_TRUE(ttsModel->required);
    EXPECT_FALSE(ttsModel->isDirectory);
}

TEST(ModelDetectValidation, TtsModelPathsToStringMapOmitsEmptyValues) {
    sherpaonnx::TtsModelPaths paths;
    paths.ttsModel = "/tmp/model.onnx";
    paths.tokens = "/tmp/tokens.txt";
    paths.dataDir = "/tmp/espeak-ng-data";
    auto map = sherpaonnx::TtsModelPathsToStringMap(paths);
    EXPECT_EQ(map.at("ttsModel"), "/tmp/model.onnx");
    EXPECT_EQ(map.at("tokens"), "/tmp/tokens.txt");
    EXPECT_EQ(map.at("dataDir"), "/tmp/espeak-ng-data");
    EXPECT_EQ(map.find("lexicon"), map.end());
}

}  // namespace

TEST(ModelDetectTest, ResolveLexiconPathSelectsByLanguageId) {
    std::vector<sherpaonnx::model_detect::LexiconCandidate> candidates = {
        {"/models/lexicon.txt", "default"},
        {"/models/lexicon-zh.txt", "zh"},
        {"/models/lexicon-us-en.txt", "us-en"},
    };
    EXPECT_EQ(sherpaonnx::model_detect::ResolveLexiconPath(candidates, ""), "/models/lexicon.txt");
    EXPECT_EQ(sherpaonnx::model_detect::ResolveLexiconPath(candidates, "zh"), "/models/lexicon-zh.txt");
    EXPECT_EQ(sherpaonnx::model_detect::ResolveLexiconPath(candidates, "missing"), "");
    EXPECT_TRUE(sherpaonnx::model_detect::ResolveLexiconPath({}, "zh").empty());
}

TEST(UnifiedModelDetectTest, EmptyInputReturnsNoMatch) {
    auto result = sherpaonnx::DetectModel(std::nullopt, std::nullopt);
    EXPECT_FALSE(result.matched);
    EXPECT_FALSE(result.success);
}

TEST(UnifiedModelDetectTest, NameOnlyTtsAssetMatchesTtsCategory) {
    auto result = sherpaonnx::DetectModel(
        std::nullopt,
        std::optional<std::string>("vits-piper-en_US-lessac-medium"));
    EXPECT_TRUE(result.matched);
    EXPECT_EQ(result.category, "tts");
    EXPECT_EQ(result.modelType, "vits");
    EXPECT_TRUE(result.isStreaming);
}

TEST(UnifiedModelDetectTest, NameOnlySupertonicRepoMatchesTtsCategory) {
    auto result = sherpaonnx::DetectModel(
        std::nullopt, std::optional<std::string>("supertonic-3"));
    EXPECT_TRUE(result.matched);
    EXPECT_EQ(result.category, "tts");
    EXPECT_EQ(result.modelType, "supertonic");
}

TEST(UnifiedModelDetectTest, BatchPreservesOrderAndLength) {
    std::vector<sherpaonnx::UnifiedModelDetectInput> inputs = {
        {std::nullopt, std::optional<std::string>("vits-piper-en")},
        {std::nullopt, std::optional<std::string>("not-a-real-model-name-xyz")},
    };
    auto results = sherpaonnx::DetectModelsBatch(inputs);
    ASSERT_EQ(results.size(), 2u);
    EXPECT_TRUE(results[0].matched);
    EXPECT_EQ(results[0].category, "tts");
    EXPECT_FALSE(results[1].matched);
}
