#include "sherpa-onnx-validate-diarization.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const DiarizationFieldRequirement kGenericReqs[] = {
    {"model", &DiarizationModelPaths::model, true},
};

static const DiarizationFieldRequirement kSortformerReqs[] = {
    {"model", &DiarizationModelPaths::model, true},
    {"metadata", &DiarizationModelPaths::metadata, false},
};

static const DiarizationFieldRequirement* GetRequirements(
    DiarizationModelKind kind,
    size_t& count
) {
    switch (kind) {
        case DiarizationModelKind::kPyannote:
        case DiarizationModelKind::kReverb:
            count = std::size(kGenericReqs);
            return kGenericReqs;
        case DiarizationModelKind::kSortformer:
            count = std::size(kSortformerReqs);
            return kSortformerReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* DiarizationKindToName(DiarizationModelKind kind) {
    switch (kind) {
        case DiarizationModelKind::kPyannote:
            return "pyannote";
        case DiarizationModelKind::kReverb:
            return "reverb";
        case DiarizationModelKind::kSortformer:
            return "sortformer";
        default:
            return "Unknown";
    }
}

} // namespace

DiarizationValidationResult ValidateDiarizationPaths(
    DiarizationModelKind kind,
    const DiarizationModelPaths& paths,
    const std::string& modelDir
) {
    DiarizationValidationResult result;
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
        result.error = std::string("Diarization ") + DiarizationKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetDiarizationPathRequirements(
    DiarizationModelKind kind
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
