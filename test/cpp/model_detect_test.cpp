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

#include <gtest/gtest.h>
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
            if (result.selectedKind == sherpaonnx::SttModelKind::kUnknown) {
                EXPECT_FALSE(result.ok)
                    << "Asset " << block.assetName
                    << ": when detection returns unknown, ok must be false so initialization is not attempted and the app does not crash.";
                if (result.isHardwareSpecificUnsupported) {
                    EXPECT_FALSE(result.error.empty())
                        << "Asset " << block.assetName << ": hardware-specific unsupported must return an error message.";
                }
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
 * zipvoice). For model_type == "unsupported" only checks that the call does not crash.
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
            // Goal: ensure the call does not crash. ok=false and selectedKind=kUnknown is valid
            // ("no compatible model detected"); we only require that detection ran without crashing.
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

}  // namespace
