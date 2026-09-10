#include "sherpa-onnx-validate-audio-tagging.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const AudioTaggingFieldRequirement kGenericReqs[] = {
    {"model", &AudioTaggingModelPaths::model, true},
    {"labels", &AudioTaggingModelPaths::labels, true},
};

static const AudioTaggingFieldRequirement* GetRequirements(
    AudioTaggingModelKind kind,
    size_t& count
) {
    switch (kind) {
        case AudioTaggingModelKind::kZipformer:
        case AudioTaggingModelKind::kCed:
            count = std::size(kGenericReqs);
            return kGenericReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* AudioTaggingKindToName(AudioTaggingModelKind kind) {
    switch (kind) {
        case AudioTaggingModelKind::kZipformer:
            return "zipformer";
        case AudioTaggingModelKind::kCed:
            return "ced";
        default:
            return "Unknown";
    }
}

} // namespace

AudioTaggingValidationResult ValidateAudioTaggingPaths(
    AudioTaggingModelKind kind,
    const AudioTaggingModelPaths& paths,
    const std::string& modelDir
) {
    AudioTaggingValidationResult result;
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
        result.error = std::string("AudioTagging ") + AudioTaggingKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetAudioTaggingPathRequirements(
    AudioTaggingModelKind kind
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
