#ifndef SHERPA_ONNX_VALIDATE_PUNCTUATION_H
#define SHERPA_ONNX_VALIDATE_PUNCTUATION_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct PunctuationValidationResult {
    bool ok = true;
    std::string error;
    std::vector<std::string> missingRequired;
};

PunctuationValidationResult ValidatePunctuationPaths(
    PunctuationModelKind kind,
    const PunctuationModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetPunctuationPathRequirements(
    PunctuationModelKind kind
);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_PUNCTUATION_H
