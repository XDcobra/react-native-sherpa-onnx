#ifndef SHERPA_ONNX_VALIDATE_SLID_H
#define SHERPA_ONNX_VALIDATE_SLID_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct LanguageIdFieldRequirement {
    const char* fieldName;
    std::string LanguageIdModelPaths::* field;
    bool required;
};

struct LanguageIdValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

LanguageIdValidationResult ValidateLanguageIdPaths(
    LanguageIdModelKind kind,
    const LanguageIdModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetLanguageIdPathRequirements(
    LanguageIdModelKind kind
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_SLID_H
