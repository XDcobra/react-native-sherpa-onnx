#include "sherpa-onnx-validate-kws.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const KwsFieldRequirement kTransducerReqs[] = {
    {"encoder", &KwsModelPaths::encoder, true},
    {"decoder", &KwsModelPaths::decoder, true},
    {"joiner", &KwsModelPaths::joiner, true},
    {"tokens", &KwsModelPaths::tokens, true},
    {"keywords", &KwsModelPaths::keywords, true},
};

static const KwsFieldRequirement* GetRequirements(KwsModelKind kind, size_t& count) {
    switch (kind) {
        case KwsModelKind::kTransducer:
            count = std::size(kTransducerReqs);
            return kTransducerReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* KwsKindToName(KwsModelKind kind) {
    switch (kind) {
        case KwsModelKind::kTransducer:
            return "transducer";
        default:
            return "Unknown";
    }
}

} // namespace

KwsValidationResult ValidateKwsPaths(
    KwsModelKind kind,
    const KwsModelPaths& paths,
    const std::string& modelDir
) {
    KwsValidationResult result;
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
        result.error = std::string("KWS ") + KwsKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }
    return result;
}

std::vector<CustomPathFieldSpec> GetKwsPathRequirements(KwsModelKind kind) {
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
