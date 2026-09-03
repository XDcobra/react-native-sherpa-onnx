#include "sherpa-onnx-validate-speaker-embedding.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const SpeakerEmbeddingFieldRequirement kGenericReqs[] = {
    {"model", &SpeakerEmbeddingModelPaths::model, true},
};

static const SpeakerEmbeddingFieldRequirement* GetRequirements(
    SpeakerEmbeddingModelKind kind,
    size_t& count
) {
    switch (kind) {
        case SpeakerEmbeddingModelKind::kWespeaker:
        case SpeakerEmbeddingModelKind::k3dSpeaker:
        case SpeakerEmbeddingModelKind::kNemo:
            count = std::size(kGenericReqs);
            return kGenericReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* SpeakerEmbeddingKindToName(SpeakerEmbeddingModelKind kind) {
    switch (kind) {
        case SpeakerEmbeddingModelKind::kWespeaker:
            return "wespeaker";
        case SpeakerEmbeddingModelKind::k3dSpeaker:
            return "3d-speaker";
        case SpeakerEmbeddingModelKind::kNemo:
            return "nemo";
        default:
            return "Unknown";
    }
}

} // namespace

SpeakerEmbeddingValidationResult ValidateSpeakerEmbeddingPaths(
    SpeakerEmbeddingModelKind kind,
    const SpeakerEmbeddingModelPaths& paths,
    const std::string& modelDir
) {
    SpeakerEmbeddingValidationResult result;
    size_t count = 0;
    const auto* reqs = GetRequirements(kind, count);
    if (!reqs) return result;

    for (size_t i = 0; i < count; ++i) {
        if (reqs[i].required && (paths.*(reqs[i].field)).empty()) {
            result.missingRequired.push_back(reqs[i].fieldName);
        }
    }

    if (!result.missingRequired.empty()) {
        result.ok = false;
        result.error = std::string("SpeakerEmbedding ") + SpeakerEmbeddingKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetSpeakerEmbeddingPathRequirements(
    SpeakerEmbeddingModelKind kind
) {
    std::vector<CustomPathFieldSpec> specs;
    size_t count = 0;
    const auto* reqs = GetRequirements(kind, count);
    if (!reqs) return specs;
    specs.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        specs.push_back({reqs[i].fieldName, reqs[i].required});
    }
    return specs;
}

} // namespace sherpaonnx
