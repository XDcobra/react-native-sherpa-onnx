#ifndef SHERPA_ONNX_VALIDATE_AUDIO_TAGGING_H
#define SHERPA_ONNX_VALIDATE_AUDIO_TAGGING_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct AudioTaggingFieldRequirement {
    const char* fieldName;
    std::string AudioTaggingModelPaths::* field;
    bool required;
};

struct AudioTaggingValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

AudioTaggingValidationResult ValidateAudioTaggingPaths(
    AudioTaggingModelKind kind,
    const AudioTaggingModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetAudioTaggingPathRequirements(
    AudioTaggingModelKind kind
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_AUDIO_TAGGING_H
