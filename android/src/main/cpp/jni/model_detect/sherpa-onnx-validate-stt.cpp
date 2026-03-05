/**
 * sherpa-onnx-validate-stt.cpp
 *
 * Validates that all required file paths are set for a given SttModelKind.
 * Requirements are declared in static tables at the top of this file —
 * edit them when adding a new model type or changing what is required.
 */
#include "sherpa-onnx-validate-stt.h"
#include <cstddef>
#include <cstring>

namespace sherpaonnx {
namespace {

// ============================================================
// REQUIREMENT TABLES — one entry per SttModelKind (or group).
// Edit here when adding a new model type or changing requirements.
// ============================================================

static const SttFieldRequirement kTransducerReqs[] = {
    {"encoder",  &SttModelPaths::encoder,  true},
    {"decoder",  &SttModelPaths::decoder,  true},
    {"joiner",   &SttModelPaths::joiner,   true},
    {"tokens",   &SttModelPaths::tokens,   true},
    {"bpeVocab", &SttModelPaths::bpeVocab, false},
};

// Offline paraformer uses paraformerModel; streaming paraformer uses encoder+decoder.
// Both are valid — validated via custom logic in ValidateSttPaths, not via this table.
static const SttFieldRequirement kParaformerReqs[] = {
    {"paraformerModel", &SttModelPaths::paraformerModel, false},
    {"encoder",         &SttModelPaths::encoder,         false},
    {"decoder",         &SttModelPaths::decoder,         false},
    {"tokens",          &SttModelPaths::tokens,          true},
};

static const SttFieldRequirement kCtcReqs[] = {
    {"ctcModel", &SttModelPaths::ctcModel, true},
    {"tokens",   &SttModelPaths::tokens,   true},
};

static const SttFieldRequirement kWhisperReqs[] = {
    {"whisperEncoder", &SttModelPaths::whisperEncoder, true},
    {"whisperDecoder", &SttModelPaths::whisperDecoder, true},
    {"tokens",         &SttModelPaths::tokens,         true},
};

static const SttFieldRequirement kFunAsrNanoReqs[] = {
    {"funasrEncoderAdaptor", &SttModelPaths::funasrEncoderAdaptor, true},
    {"funasrLLM",            &SttModelPaths::funasrLLM,            true},
    {"funasrEmbedding",      &SttModelPaths::funasrEmbedding,      true},
    {"funasrTokenizer",      &SttModelPaths::funasrTokenizer,      true},
};

static const SttFieldRequirement kMoonshineReqs[] = {
    {"moonshinePreprocessor",    &SttModelPaths::moonshinePreprocessor,    true},
    {"moonshineEncoder",         &SttModelPaths::moonshineEncoder,         true},
    {"moonshineUncachedDecoder", &SttModelPaths::moonshineUncachedDecoder, true},
    {"moonshineCachedDecoder",   &SttModelPaths::moonshineCachedDecoder,   true},
};

static const SttFieldRequirement kMoonshineV2Reqs[] = {
    {"moonshineEncoder",       &SttModelPaths::moonshineEncoder,       true},
    {"moonshineMergedDecoder", &SttModelPaths::moonshineMergedDecoder, true},
};

static const SttFieldRequirement kFireRedReqs[] = {
    {"fireRedEncoder", &SttModelPaths::fireRedEncoder, true},
    {"fireRedDecoder", &SttModelPaths::fireRedDecoder, true},
    {"tokens",         &SttModelPaths::tokens,         true},
};

static const SttFieldRequirement kCanaryReqs[] = {
    {"canaryEncoder", &SttModelPaths::canaryEncoder, true},
    {"canaryDecoder", &SttModelPaths::canaryDecoder, true},
    {"tokens",        &SttModelPaths::tokens,        true},
};

static const SttFieldRequirement kDolphinReqs[] = {
    {"dolphinModel", &SttModelPaths::dolphinModel, true},
    {"tokens",       &SttModelPaths::tokens,       true},
};

static const SttFieldRequirement kOmnilingualReqs[] = {
    {"omnilingualModel", &SttModelPaths::omnilingualModel, true},
    {"tokens",           &SttModelPaths::tokens,           true},
};

static const SttFieldRequirement kMedAsrReqs[] = {
    {"medasrModel", &SttModelPaths::medasrModel, true},
    {"tokens",      &SttModelPaths::tokens,      true},
};

static const SttFieldRequirement kTeleSpeechReqs[] = {
    {"telespeechCtcModel", &SttModelPaths::telespeechCtcModel, true},
    {"tokens",             &SttModelPaths::tokens,             true},
};

// ============================================================

static const SttFieldRequirement* GetRequirements(SttModelKind kind, size_t& count) {
    switch (kind) {
        case SttModelKind::kTransducer:
        case SttModelKind::kNemoTransducer:
            count = std::size(kTransducerReqs);
            return kTransducerReqs;
        case SttModelKind::kParaformer:
            count = std::size(kParaformerReqs);
            return kParaformerReqs;
        case SttModelKind::kNemoCtc:
        case SttModelKind::kWenetCtc:
        case SttModelKind::kSenseVoice:
        case SttModelKind::kZipformerCtc:
        case SttModelKind::kToneCtc:
            count = std::size(kCtcReqs);
            return kCtcReqs;
        case SttModelKind::kWhisper:
            count = std::size(kWhisperReqs);
            return kWhisperReqs;
        case SttModelKind::kFunAsrNano:
            count = std::size(kFunAsrNanoReqs);
            return kFunAsrNanoReqs;
        case SttModelKind::kMoonshine:
            count = std::size(kMoonshineReqs);
            return kMoonshineReqs;
        case SttModelKind::kMoonshineV2:
            count = std::size(kMoonshineV2Reqs);
            return kMoonshineV2Reqs;
        case SttModelKind::kFireRedAsr:
            count = std::size(kFireRedReqs);
            return kFireRedReqs;
        case SttModelKind::kCanary:
            count = std::size(kCanaryReqs);
            return kCanaryReqs;
        case SttModelKind::kDolphin:
            count = std::size(kDolphinReqs);
            return kDolphinReqs;
        case SttModelKind::kOmnilingual:
            count = std::size(kOmnilingualReqs);
            return kOmnilingualReqs;
        case SttModelKind::kMedAsr:
            count = std::size(kMedAsrReqs);
            return kMedAsrReqs;
        case SttModelKind::kTeleSpeechCtc:
            count = std::size(kTeleSpeechReqs);
            return kTeleSpeechReqs;
        default:
            count = 0;
            return nullptr;
    }
}

static const char* SttKindToName(SttModelKind k) {
    switch (k) {
        case SttModelKind::kTransducer:    return "Transducer";
        case SttModelKind::kNemoTransducer: return "NeMo Transducer";
        case SttModelKind::kParaformer:    return "Paraformer";
        case SttModelKind::kNemoCtc:       return "NeMo CTC";
        case SttModelKind::kWenetCtc:      return "WeNet CTC";
        case SttModelKind::kSenseVoice:    return "SenseVoice";
        case SttModelKind::kZipformerCtc:  return "Zipformer CTC";
        case SttModelKind::kWhisper:       return "Whisper";
        case SttModelKind::kFunAsrNano:    return "FunASR Nano";
        case SttModelKind::kFireRedAsr:    return "Fire Red ASR";
        case SttModelKind::kMoonshine:     return "Moonshine";
        case SttModelKind::kMoonshineV2:   return "Moonshine v2";
        case SttModelKind::kDolphin:       return "Dolphin";
        case SttModelKind::kCanary:        return "Canary";
        case SttModelKind::kOmnilingual:   return "Omnilingual";
        case SttModelKind::kMedAsr:        return "MedASR";
        case SttModelKind::kTeleSpeechCtc: return "TeleSpeech CTC";
        case SttModelKind::kToneCtc:       return "Tone CTC";
        default:                           return "Unknown";
    }
}

static const char* GetFieldHint(const char* fieldName) {
    if (std::strcmp(fieldName, "tokens") == 0)
        return "Ensure tokens.txt is present in the model directory.";
    return nullptr;
}

} // namespace

SttValidationResult ValidateSttPaths(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
) {
    SttValidationResult result;
    size_t count = 0;
    const auto* reqs = GetRequirements(kind, count);
    if (!reqs) return result;

    for (size_t i = 0; i < count; ++i) {
        if (reqs[i].required && (paths.*(reqs[i].field)).empty()) {
            result.missingRequired.push_back(reqs[i].fieldName);
        }
    }

    // Paraformer: offline uses paraformerModel, streaming uses encoder+decoder.
    // At least one variant must be present.
    if (kind == SttModelKind::kParaformer) {
        bool hasOffline = !paths.paraformerModel.empty();
        bool hasStreaming = !paths.encoder.empty() && !paths.decoder.empty();
        if (!hasOffline && !hasStreaming) {
            result.missingRequired.push_back("paraformerModel (or encoder+decoder for streaming)");
        }
    }

    if (!result.missingRequired.empty()) {
        result.ok = false;
        result.error = std::string("STT ") + SttKindToName(kind)
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
