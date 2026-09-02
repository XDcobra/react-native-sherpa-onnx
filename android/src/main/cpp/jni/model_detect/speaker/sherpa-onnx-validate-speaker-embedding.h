#ifndef SHERPA_ONNX_VALIDATE_SPEAKER_EMBEDDING_H
#define SHERPA_ONNX_VALIDATE_SPEAKER_EMBEDDING_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

struct SpeakerEmbeddingFieldRequirement {
    const char* fieldName;
    std::string SpeakerEmbeddingModelPaths::* field;
    bool required;
};

struct SpeakerEmbeddingValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

SpeakerEmbeddingValidationResult ValidateSpeakerEmbeddingPaths(
    SpeakerEmbeddingModelKind kind,
    const SpeakerEmbeddingModelPaths& paths,
    const std::string& modelDir
);

std::vector<CustomPathFieldSpec> GetSpeakerEmbeddingPathRequirements(
    SpeakerEmbeddingModelKind kind
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VALIDATE_SPEAKER_EMBEDDING_H
