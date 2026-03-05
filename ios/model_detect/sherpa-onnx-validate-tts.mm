/**
 * sherpa-onnx-validate-tts.mm
 *
 * Validates that all required file paths are set for a given TtsModelKind.
 * Requirements are declared in static tables at the top of this file —
 * edit them when adding a new model type or changing what is required.
 */
#include "sherpa-onnx-validate-tts.h"
#include <cstddef>
#include <cstring>

namespace sherpaonnx {
namespace {

// ============================================================
// REQUIREMENT TABLES — one entry per TtsModelKind.
// Edit here when adding a new model type or changing requirements.
// ============================================================

static const TtsFieldRequirement kVitsReqs[] = {
    {"ttsModel", &TtsModelPaths::ttsModel, true},
    {"tokens",   &TtsModelPaths::tokens,   true},
    {"dataDir",  &TtsModelPaths::dataDir,  false},
    {"lexicon",  &TtsModelPaths::lexicon,  false},
};

static const TtsFieldRequirement kMatchaReqs[] = {
    {"acousticModel", &TtsModelPaths::acousticModel, true},
    {"vocoder",       &TtsModelPaths::vocoder,       true},
    {"tokens",        &TtsModelPaths::tokens,        true},
    {"dataDir",       &TtsModelPaths::dataDir,       false},
    {"lexicon",       &TtsModelPaths::lexicon,       false},
};

static const TtsFieldRequirement kKokoroReqs[] = {
    {"ttsModel", &TtsModelPaths::ttsModel, true},
    {"tokens",   &TtsModelPaths::tokens,   true},
    {"voices",   &TtsModelPaths::voices,   true},
    {"dataDir",  &TtsModelPaths::dataDir,  true},
    {"lexicon",  &TtsModelPaths::lexicon,  false},
};

static const TtsFieldRequirement kPocketReqs[] = {
    {"lmFlow",          &TtsModelPaths::lmFlow,          true},
    {"lmMain",          &TtsModelPaths::lmMain,          true},
    {"encoder",         &TtsModelPaths::encoder,         true},
    {"decoder",         &TtsModelPaths::decoder,         true},
    {"textConditioner", &TtsModelPaths::textConditioner, true},
    {"vocabJson",       &TtsModelPaths::vocabJson,       true},
    {"tokenScoresJson", &TtsModelPaths::tokenScoresJson, true},
};

static const TtsFieldRequirement kZipvoiceReqs[] = {
    {"encoder",  &TtsModelPaths::encoder,  true},
    {"decoder",  &TtsModelPaths::decoder,  true},
    {"vocoder",  &TtsModelPaths::vocoder,  true},
    {"tokens",   &TtsModelPaths::tokens,   true},
    {"dataDir",  &TtsModelPaths::dataDir,  false},
    {"lexicon",  &TtsModelPaths::lexicon,  false},
};

// ============================================================

static const TtsFieldRequirement* GetRequirements(TtsModelKind kind, size_t& count) {
    switch (kind) {
        case TtsModelKind::kVits:
            count = std::size(kVitsReqs);
            return kVitsReqs;
        case TtsModelKind::kMatcha:
            count = std::size(kMatchaReqs);
            return kMatchaReqs;
        case TtsModelKind::kKokoro:
        case TtsModelKind::kKitten:
            count = std::size(kKokoroReqs);
            return kKokoroReqs;
        case TtsModelKind::kPocket:
            count = std::size(kPocketReqs);
            return kPocketReqs;
        case TtsModelKind::kZipvoice:
            count = std::size(kZipvoiceReqs);
            return kZipvoiceReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* TtsKindToName(TtsModelKind k) {
    switch (k) {
        case TtsModelKind::kVits:     return "VITS";
        case TtsModelKind::kMatcha:   return "Matcha";
        case TtsModelKind::kKokoro:   return "Kokoro";
        case TtsModelKind::kKitten:   return "Kitten";
        case TtsModelKind::kPocket:   return "Pocket";
        case TtsModelKind::kZipvoice: return "Zipvoice";
        default:                      return "Unknown";
    }
}

static const char* GetFieldHint(const char* fieldName) {
    if (std::strcmp(fieldName, "dataDir") == 0)
        return "Copy espeak-ng-data into the model directory.";
    if (std::strcmp(fieldName, "tokens") == 0)
        return "Ensure tokens.txt is present in the model directory.";
    return nullptr;
}

} // namespace

TtsValidationResult ValidateTtsPaths(
    TtsModelKind kind,
    const TtsModelPaths& paths,
    const std::string& modelDir
) {
    TtsValidationResult result;
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
        result.error = std::string("TTS ") + TtsKindToName(kind)
                     + ": missing required files in " + modelDir + ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) result.error += ", ";
            result.error += result.missingRequired[i];
            const char* hint = GetFieldHint(result.missingRequired[i].c_str());
            if (hint) {
                result.error += " (";
                result.error += hint;
                result.error += ")";
            }
        }
    }
    return result;
}

} // namespace sherpaonnx
