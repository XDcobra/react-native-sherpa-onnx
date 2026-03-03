/**
 * model_detect_test.cpp
 *
 * Host-side GTest suite for STT (speech-to-text) model detection. Tests run without
 * real model files: they use path-only fixtures that describe the directory layout
 * of ASR model assets (e.g. from k2-fsa/sherpa-onnx asr-models release).
 *
 * Fixtures:
 *   - asr-models-structure.txt: One block per asset (# Asset: name.tar.bz2), each block
 *     lists relative paths (modelDir/encoder.onnx, modelDir/tokens.txt, ...) as produced
 *     by the collect-asr-model-structures workflow.
 *   - asr-models-expected.csv: Header "asset_name,model_type"; each row declares the
 *     expected detection result (e.g. transducer, paraformer, zipformer) or "unsupported".
 *
 * The tests build a FileEntry list from the structure file, call DetectSttModelFromFileList
 * (test-only API that uses no filesystem), and assert that the selected model kind matches
 * the expected value from the CSV. Run from repo root so "test/fixtures" resolves, or set
 * TEST_FIXTURES_DIR to the directory containing the two fixture files.
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
 * Checks that the fixture files exist and are readable. Fails with a clear
 * error message if asr-models-structure.txt or asr-models-expected.csv
 * are missing (e.g., incorrect working directory or TEST_FIXTURES_DIR). Should be run as the
 * first test so that subsequent tests do not abort with cryptic parse errors
 * .
 */
TEST(ModelDetectTest, FixturesExist) {
    std::string dir = GetFixturesDir();
    std::string structurePath = dir + "/asr-models-structure.txt";
    std::string csvPath = dir + "/asr-models-expected.csv";
    std::ifstream s(structurePath), c(csvPath);
    ASSERT_TRUE(s.is_open()) << "Missing fixture: " << structurePath;
    ASSERT_TRUE(c.is_open()) << "Missing fixture: " << csvPath;
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
 *    - If model_type == “unsupported”: Only checks that DetectSttModelFromFileList
 *      does not crash and either ok==true or a meaningful selectedKind is returned.
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
            EXPECT_TRUE(result.ok || result.selectedKind != sherpaonnx::SttModelKind::kUnknown)
                << "Asset " << block.assetName << ": unsupported should not crash; ok=" << result.ok;
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

}  // namespace
