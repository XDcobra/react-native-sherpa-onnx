#include "sherpa-onnx-validate-slid.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const LanguageIdFieldRequirement kWhisperReqs[] = {
    {"encoder", &LanguageIdModelPaths::encoder, true},
    {"decoder", &LanguageIdModelPaths::decoder, true},
};

static const LanguageIdFieldRequirement* GetRequirements(
    LanguageIdModelKind kind,
    size_t& count
) {
    switch (kind) {
        case LanguageIdModelKind::kWhisper:
            count = std::size(kWhisperReqs);
            return kWhisperReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* LanguageIdKindToName(LanguageIdModelKind kind) {
    switch (kind) {
        case LanguageIdModelKind::kWhisper:
            return "whisper";
        default:
            return "Unknown";
    }
}

} // namespace

LanguageIdValidationResult ValidateLanguageIdPaths(
    LanguageIdModelKind kind,
    const LanguageIdModelPaths& paths,
    const std::string& modelDir
) {
    LanguageIdValidationResult result;
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
        result.error = std::string("LanguageId ") + LanguageIdKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetLanguageIdPathRequirements(
    LanguageIdModelKind kind
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
