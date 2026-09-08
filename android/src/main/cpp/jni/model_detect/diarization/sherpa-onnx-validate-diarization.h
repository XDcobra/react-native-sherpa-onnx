#ifndef SHERPA_ONNX_VALIDATE_DIARIZATION_H
#define SHERPA_ONNX_VALIDATE_DIARIZATION_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct DiarizationFieldRequirement {
    const char* fieldName;
    std::string DiarizationModelPaths::* field;
    bool required;
};

struct DiarizationValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

DiarizationValidationResult ValidateDiarizationPaths(
    DiarizationModelKind kind,
    const DiarizationModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetDiarizationPathRequirements(
    DiarizationModelKind kind
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_DIARIZATION_H
