#ifndef SHERPA_ONNX_VALIDATE_ENHANCEMENT_H
#define SHERPA_ONNX_VALIDATE_ENHANCEMENT_H

#include "sherpa-onnx-model-detect.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct EnhancementFieldRequirement {
    const char* fieldName;
    std::string EnhancementModelPaths::* field;
    bool required;
};

struct EnhancementValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

EnhancementValidationResult ValidateEnhancementPaths(
    EnhancementModelKind kind,
    const EnhancementModelPaths& paths,
    const std::string& modelDir
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_ENHANCEMENT_H
