#ifndef SHERPA_ONNX_VALIDATE_OCR_H
#define SHERPA_ONNX_VALIDATE_OCR_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct OcrFieldRequirement {
    const char* fieldName;
    std::string OcrModelPaths::* field;
    bool required;
};

struct OcrValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

OcrValidationResult ValidateOcrPaths(
    OcrModelKind kind,
    const OcrModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetOcrPathRequirements(OcrModelKind kind);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_OCR_H
