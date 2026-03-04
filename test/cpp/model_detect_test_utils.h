/**
 * model_detect_test_utils.h
 *
 * Test-only helpers for the C++ model detection test suite.
 * Contains fixture parsing (structure.txt + expected.csv for ASR and TTS),
 * building FileEntry lists from path lines, and mapping model_type strings to
 * SttModelKind / TtsModelKind. Do not use in production code.
 */

#ifndef MODEL_DETECT_TEST_UTILS_H
#define MODEL_DETECT_TEST_UTILS_H

#include "sherpa-onnx-model-detect-helper.h"
#include <map>
#include <string>
#include <vector>

namespace sherpaonnx {
enum class SttModelKind;
enum class TtsModelKind;
}

namespace model_detect_test {

/** One asset block from asr-models-structure.txt: asset name, model dir, and path lines. */
struct AssetBlock {
    std::string assetName;
    std::string modelDir;
    std::vector<std::string> pathLines;
};

/** Parse structure file (asr-models-structure.txt or tts-models-structure.txt); returns blocks (one per # Asset:). */
std::vector<AssetBlock> ParseAsrStructureFile(const std::string& filePath, std::string* outError = nullptr);

/** Parse expected CSV (asr-models-expected.csv or tts-models-expected.csv); returns map asset_name -> model_type. */
std::map<std::string, std::string> ParseAsrExpectedCsv(const std::string& filePath, std::string* outError = nullptr);

/** Build FileEntry list from path lines. Skips directory-only lines (ending with /). */
std::vector<sherpaonnx::model_detect::FileEntry> BuildFileEntriesFromPathLines(
    const std::string& modelDir,
    const std::vector<std::string>& pathLines);

/** Map CSV model_type string to SttModelKind (for test assertions). "zipformer" -> transducer; "zipformer_ctc" and "ctc" -> zipformer_ctc. */
sherpaonnx::SttModelKind SttKindFromString(const std::string& modelType);

/** Convert SttModelKind to string (same as production KindToName). */
std::string SttKindToString(sherpaonnx::SttModelKind kind);

/** Map CSV model_type string to TtsModelKind (for TTS test assertions). */
sherpaonnx::TtsModelKind TtsKindFromString(const std::string& modelType);

/** Convert TtsModelKind to string (same as production). */
std::string TtsKindToString(sherpaonnx::TtsModelKind kind);

}  // namespace model_detect_test

#endif  // MODEL_DETECT_TEST_UTILS_H
