#include "sherpa-onnx-validate-ocr.h"

#include <cstddef>

namespace sherpaonnx {
namespace {

static const OcrFieldRequirement kPpocrReqs[] = {
    {"det", &OcrModelPaths::det, true},
    {"rec", &OcrModelPaths::rec, true},
    {"rec_dict", &OcrModelPaths::rec_dict, true},
    {"cls", &OcrModelPaths::cls, false},
};

static const OcrFieldRequirement kDoctrReqs[] = {
    {"det", &OcrModelPaths::det, true},
    {"rec", &OcrModelPaths::rec, true},
    {"manifest", &OcrModelPaths::manifest, true},
    {"cls", &OcrModelPaths::cls, false},
    {"rec_dict", &OcrModelPaths::rec_dict, false},
};

static const OcrFieldRequirement* GetRequirements(OcrModelKind kind, size_t& count) {
    switch (kind) {
        case OcrModelKind::kPpocr:
            count = std::size(kPpocrReqs);
            return kPpocrReqs;
        case OcrModelKind::kDoctr:
            count = std::size(kDoctrReqs);
            return kDoctrReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* OcrKindToName(OcrModelKind kind) {
    switch (kind) {
        case OcrModelKind::kPpocr:
            return "ppocr";
        case OcrModelKind::kDoctr:
            return "doctr";
        default:
            return "unknown";
    }
}

}  // namespace

OcrValidationResult ValidateOcrPaths(
    OcrModelKind kind,
    const OcrModelPaths& paths,
    const std::string& modelDir
) {
    OcrValidationResult result;
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
        result.error = std::string("OCR ") + OcrKindToName(kind) +
                       ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
        }
    }

    return result;
}

std::vector<CustomPathFieldSpec> GetOcrPathRequirements(OcrModelKind kind) {
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
