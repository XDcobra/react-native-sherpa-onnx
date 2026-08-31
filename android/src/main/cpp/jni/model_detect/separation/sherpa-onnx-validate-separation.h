#ifndef SHERPA_ONNX_VALIDATE_SEPARATION_H
#define SHERPA_ONNX_VALIDATE_SEPARATION_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct SeparationFieldRequirement {
    const char* fieldName;
    std::string SeparationModelPaths::* field;
    bool required;
};

struct SeparationValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

SeparationValidationResult ValidateSeparationPaths(
    SeparationModelKind kind,
    const SeparationModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetSeparationPathRequirements(
    SeparationModelKind kind
);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_SEPARATION_H
