/**
 * sherpa-onnx-validate-stt.h
 *
 * Declares ValidateSttPaths(): after model detection resolves a kind and populates
 * SttModelPaths, this function checks that every *required* path field for that kind
 * is non-empty. Returns a validation result with ok/error and the list of missing
 * fields so the caller can surface a specific error instead of crashing at init time.
 */
#ifndef SHERPA_ONNX_VALIDATE_STT_H
#define SHERPA_ONNX_VALIDATE_STT_H

#include "sherpa-onnx-model-detect.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct SttFieldRequirement {
    const char* fieldName;
    std::string SttModelPaths::* field;
    bool required;
};

struct SttValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

SttValidationResult ValidateSttPaths(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_STT_H
