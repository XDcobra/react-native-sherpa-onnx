#ifndef SHERPA_ONNX_VALIDATE_KWS_H
#define SHERPA_ONNX_VALIDATE_KWS_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct KwsFieldRequirement {
    const char* fieldName;
    std::string KwsModelPaths::* field;
    bool required;
};

struct KwsValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

KwsValidationResult ValidateKwsPaths(
    KwsModelKind kind,
    const KwsModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetKwsPathRequirements(KwsModelKind kind);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_KWS_H
