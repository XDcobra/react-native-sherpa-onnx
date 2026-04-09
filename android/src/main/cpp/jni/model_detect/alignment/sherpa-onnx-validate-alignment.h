#ifndef SHERPA_ONNX_VALIDATE_ALIGNMENT_H
#define SHERPA_ONNX_VALIDATE_ALIGNMENT_H

#include "sherpa-onnx-model-detect.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct AlignmentFieldRequirement {
    const char* fieldName;
    std::string AlignmentModelPaths::* field;
    bool required;
};

struct AlignmentValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

AlignmentValidationResult ValidateAlignmentPaths(
    AlignmentModelKind kind,
    const AlignmentModelPaths& paths,
    const std::string& modelDir
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_ALIGNMENT_H
