/**
 * sherpa-onnx-validate-tts.h
 *
 * Declares ValidateTtsPaths(): after model detection resolves a kind and populates
 * TtsModelPaths, this function checks that every *required* path field for that kind
 * is non-empty. Returns a validation result with ok/error and the list of missing
 * fields so the caller can surface a specific error instead of crashing at init time.
 */
#ifndef SHERPA_ONNX_VALIDATE_TTS_H
#define SHERPA_ONNX_VALIDATE_TTS_H

#include "sherpa-onnx-model-detect.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct TtsFieldRequirement {
    const char* fieldName;
    std::string TtsModelPaths::* field;
    bool required;
};

struct TtsValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

TtsValidationResult ValidateTtsPaths(
    TtsModelKind kind,
    const TtsModelPaths& paths,
    const std::string& modelDir
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_TTS_H
