#include "sherpa-onnx-validate-alignment.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const AlignmentFieldRequirement kWav2Vec2Reqs[] = {
    {"model", &AlignmentModelPaths::model, true},
};

static const AlignmentFieldRequirement* GetRequirements(
    AlignmentModelKind kind,
    size_t& count
) {
    switch (kind) {
        case AlignmentModelKind::kWav2Vec2:
            count = std::size(kWav2Vec2Reqs);
            return kWav2Vec2Reqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* AlignmentKindToName(AlignmentModelKind kind) {
    switch (kind) {
        case AlignmentModelKind::kWav2Vec2:
            return "wav2vec2";
        default:
            return "unknown";
    }
}

} // namespace

AlignmentValidationResult ValidateAlignmentPaths(
    AlignmentModelKind kind,
    const AlignmentModelPaths& paths,
    const std::string& modelDir
) {
    AlignmentValidationResult result;
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
        result.error = std::string("Alignment ") + AlignmentKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }

    return result;
}

std::vector<CustomPathFieldSpec> GetAlignmentPathRequirements(AlignmentModelKind kind) {
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
