#include "sherpa-onnx-validate-enhancement.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const EnhancementFieldRequirement kGenericReqs[] = {
    {"model", &EnhancementModelPaths::model, true},
};

static const EnhancementFieldRequirement* GetRequirements(
    EnhancementModelKind kind,
    size_t& count
) {
    switch (kind) {
        case EnhancementModelKind::kGtcrn:
        case EnhancementModelKind::kDpdfNet:
            count = std::size(kGenericReqs);
            return kGenericReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* EnhancementKindToName(EnhancementModelKind kind) {
    switch (kind) {
        case EnhancementModelKind::kGtcrn:
            return "GTCRN";
        case EnhancementModelKind::kDpdfNet:
            return "DPDFNet";
        default:
            return "Unknown";
    }
}

} // namespace

EnhancementValidationResult ValidateEnhancementPaths(
    EnhancementModelKind kind,
    const EnhancementModelPaths& paths,
    const std::string& modelDir
) {
    EnhancementValidationResult result;
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
        result.error = std::string("Enhancement ") + EnhancementKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

} // namespace sherpaonnx
