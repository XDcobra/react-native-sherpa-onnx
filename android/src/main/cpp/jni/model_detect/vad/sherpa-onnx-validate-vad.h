#ifndef SHERPA_ONNX_VALIDATE_VAD_H
#define SHERPA_ONNX_VALIDATE_VAD_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct VadFieldRequirement {
    const char* fieldName;
    const std::string VadModelPaths::*field;
    bool required;
};

struct VadValidationResult {
    bool ok = true;
    std::string error;
    std::vector<std::string> missingRequired;
};

VadValidationResult ValidateVadPaths(
    VadModelKind kind,
    const VadModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetVadPathRequirements(VadModelKind kind);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_VAD_H
