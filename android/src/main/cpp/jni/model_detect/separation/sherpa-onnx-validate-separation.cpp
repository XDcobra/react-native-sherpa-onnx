#include "sherpa-onnx-validate-separation.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const SeparationFieldRequirement kSpleeterReqs[] = {
    {"vocals", &SeparationModelPaths::vocals, true},
    {"accompaniment", &SeparationModelPaths::accompaniment, true},
};

static const SeparationFieldRequirement kUvrReqs[] = {
    {"model", &SeparationModelPaths::model, true},
};

static const SeparationFieldRequirement* GetRequirements(
    SeparationModelKind kind,
    size_t& count
) {
    switch (kind) {
        case SeparationModelKind::kSpleeter:
            count = std::size(kSpleeterReqs);
            return kSpleeterReqs;
        case SeparationModelKind::kUvr:
            count = std::size(kUvrReqs);
            return kUvrReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* SeparationKindToName(SeparationModelKind kind) {
    switch (kind) {
        case SeparationModelKind::kSpleeter:
            return "Spleeter";
        case SeparationModelKind::kUvr:
            return "UVR";
        default:
            return "Unknown";
    }
}

}  // namespace

SeparationValidationResult ValidateSeparationPaths(
    SeparationModelKind kind,
    const SeparationModelPaths& paths,
    const std::string& modelDir
) {
    SeparationValidationResult result;
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
        result.error = std::string("Separation ") + SeparationKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetSeparationPathRequirements(
    SeparationModelKind kind
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

}  // namespace sherpaonnx
