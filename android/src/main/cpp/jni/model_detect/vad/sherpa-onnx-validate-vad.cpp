#include "sherpa-onnx-validate-vad.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const VadFieldRequirement kGenericReqs[] = {
    {"model", &VadModelPaths::model, true},
};

static const VadFieldRequirement* GetRequirements(
    VadModelKind kind,
    size_t& count
) {
    switch (kind) {
        case VadModelKind::kSileroVad:
        case VadModelKind::kTenVad:
            count = std::size(kGenericReqs);
            return kGenericReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* VadKindToName(VadModelKind kind) {
    switch (kind) {
        case VadModelKind::kSileroVad:
            return "Silero VAD";
        case VadModelKind::kTenVad:
            return "TEN VAD";
        default:
            return "Unknown";
    }
}

} // namespace

VadValidationResult ValidateVadPaths(
    VadModelKind kind,
    const VadModelPaths& paths,
    const std::string& modelDir
) {
    VadValidationResult result;
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
        result.error = std::string("VAD ") + VadKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetVadPathRequirements(VadModelKind kind) {
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
