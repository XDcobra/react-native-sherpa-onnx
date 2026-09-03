#include "sherpa-onnx-validate-custom.h"

#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-validate-alignment.h"
#include "sherpa-onnx-validate-enhancement.h"
#include "sherpa-onnx-validate-separation.h"
#include "sherpa-onnx-validate-speaker-embedding.h"
#include "sherpa-onnx-validate-punctuation.h"
#include "sherpa-onnx-validate-stt.h"
#include "sherpa-onnx-validate-online-stt.h"
#include "sherpa-onnx-validate-tts.h"
#include "sherpa-onnx-validate-vad.h"

namespace sherpaonnx {
namespace {

using model_detect::ToLower;

CustomModelValidationResult FromValidation(
    bool ok,
    const std::vector<std::string>& missingRequired,
    const std::string& error
) {
    CustomModelValidationResult out;
    out.ok = ok;
    out.missingRequired = missingRequired;
    out.error = error;
    return out;
}

CustomModelPathRequirements FromSpecs(const std::vector<CustomPathFieldSpec>& specs) {
    CustomModelPathRequirements out;
    out.fields = specs;
    return out;
}

TtsModelKind ParseTtsModelTypeLocal(const std::string& modelType) {
    if (modelType == "vits") return TtsModelKind::kVits;
    if (modelType == "matcha") return TtsModelKind::kMatcha;
    if (modelType == "kokoro") return TtsModelKind::kKokoro;
    if (modelType == "kitten") return TtsModelKind::kKitten;
    if (modelType == "pocket") return TtsModelKind::kPocket;
    if (modelType == "zipvoice") return TtsModelKind::kZipvoice;
    if (modelType == "supertonic") return TtsModelKind::kSupertonic;
    return TtsModelKind::kUnknown;
}

VadModelKind ParseVadModelTypeLocal(const std::string& modelType) {
    if (modelType == "silero_vad") return VadModelKind::kSileroVad;
    if (modelType == "ten_vad") return VadModelKind::kTenVad;
    return VadModelKind::kUnknown;
}

EnhancementModelKind ParseEnhancementModelTypeLocal(const std::string& modelType) {
    if (modelType == "gtcrn") return EnhancementModelKind::kGtcrn;
    if (modelType == "dpdfnet") return EnhancementModelKind::kDpdfNet;
    return EnhancementModelKind::kUnknown;
}

PunctuationModelKind ParsePunctuationModelTypeLocal(const std::string& modelType) {
    const std::string t = ToLower(modelType);
    if (t == "ct_transformer" || t == "offline") {
        return PunctuationModelKind::kCtTransformer;
    }
    if (t == "cnn_bilstm" || t == "online") {
        return PunctuationModelKind::kCnnBilstm;
    }
    return PunctuationModelKind::kUnknown;
}

AlignmentModelKind ParseAlignmentModelTypeLocal(const std::string& modelType) {
    if (modelType == "wav2vec2") return AlignmentModelKind::kWav2Vec2;
    return AlignmentModelKind::kUnknown;
}

SeparationModelKind ParseSeparationModelTypeLocal(const std::string& modelType) {
    if (modelType == "spleeter") return SeparationModelKind::kSpleeter;
    if (modelType == "uvr") return SeparationModelKind::kUvr;
    return SeparationModelKind::kUnknown;
}

SpeakerEmbeddingModelKind ParseSpeakerEmbeddingModelTypeLocal(
    const std::string& modelType
) {
    if (modelType == "wespeaker") return SpeakerEmbeddingModelKind::kWespeaker;
    if (modelType == "3d-speaker") return SpeakerEmbeddingModelKind::k3dSpeaker;
    if (modelType == "nemo") return SpeakerEmbeddingModelKind::kNemo;
    return SpeakerEmbeddingModelKind::kUnknown;
}

}  // namespace

CustomModelValidationResult ValidateCustomModelPaths(
    const std::string& category,
    const std::string& modelType,
    const std::map<std::string, std::string>& paths,
    const std::string& contextLabel
) {
    const std::string cat = ToLower(category);

    if (cat == "stt") {
        const SttModelKind kind = ParseSttModelType(modelType);
        if (kind == SttModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom STT model type: " + modelType
            );
        }
        SttModelPaths sttPaths;
        FillSttModelPathsFromStringMap(paths, sttPaths);
        const auto vr = ValidateSttPaths(kind, sttPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "stt_streaming") {
        const OnlineSttModelKind kind = ParseOnlineSttModelType(modelType);
        if (kind == OnlineSttModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom streaming STT model type: " + modelType
            );
        }
        OnlineSttModelPaths onlinePaths;
        FillOnlineSttModelPathsFromStringMap(paths, onlinePaths);
        const auto vr = ValidateOnlineSttPaths(kind, onlinePaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "tts") {
        const TtsModelKind kind = ParseTtsModelTypeLocal(modelType);
        if (kind == TtsModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom TTS model type: " + modelType
            );
        }
        TtsModelPaths ttsPaths;
        FillTtsModelPathsFromStringMap(paths, ttsPaths);
        const auto vr = ValidateTtsPaths(kind, ttsPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "vad") {
        const VadModelKind kind = ParseVadModelTypeLocal(modelType);
        if (kind == VadModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom VAD model type: " + modelType
            );
        }
        VadModelPaths vadPaths;
        FillVadModelPathsFromStringMap(paths, vadPaths);
        const auto vr = ValidateVadPaths(kind, vadPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "enhancement") {
        const EnhancementModelKind kind = ParseEnhancementModelTypeLocal(modelType);
        if (kind == EnhancementModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom enhancement model type: " + modelType
            );
        }
        EnhancementModelPaths enhancementPaths;
        FillEnhancementModelPathsFromStringMap(paths, enhancementPaths);
        const auto vr = ValidateEnhancementPaths(kind, enhancementPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "separation") {
        const SeparationModelKind kind = ParseSeparationModelTypeLocal(modelType);
        if (kind == SeparationModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom separation model type: " + modelType
            );
        }
        SeparationModelPaths separationPaths;
        FillSeparationModelPathsFromStringMap(paths, separationPaths);
        const auto vr = ValidateSeparationPaths(kind, separationPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "speakerembedding" || cat == "speaker_embedding") {
        const SpeakerEmbeddingModelKind kind =
            ParseSpeakerEmbeddingModelTypeLocal(modelType);
        if (kind == SpeakerEmbeddingModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom speaker embedding model type: " + modelType
            );
        }
        SpeakerEmbeddingModelPaths speakerEmbeddingPaths;
        FillSpeakerEmbeddingModelPathsFromStringMap(paths, speakerEmbeddingPaths);
        const auto vr = ValidateSpeakerEmbeddingPaths(
            kind,
            speakerEmbeddingPaths,
            contextLabel
        );
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "punctuation") {
        const PunctuationModelKind kind = ParsePunctuationModelTypeLocal(modelType);
        if (kind == PunctuationModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom punctuation model type: " + modelType
            );
        }
        PunctuationModelPaths punctuationPaths;
        FillPunctuationModelPathsFromStringMap(paths, punctuationPaths);
        const auto vr = ValidatePunctuationPaths(kind, punctuationPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    if (cat == "alignment") {
        const AlignmentModelKind kind = ParseAlignmentModelTypeLocal(modelType);
        if (kind == AlignmentModelKind::kUnknown) {
            return FromValidation(
                false,
                {},
                "Unsupported custom alignment model type: " + modelType
            );
        }
        AlignmentModelPaths alignmentPaths;
        FillAlignmentModelPathsFromStringMap(paths, alignmentPaths);
        const auto vr = ValidateAlignmentPaths(kind, alignmentPaths, contextLabel);
        return FromValidation(vr.ok, vr.missingRequired, vr.error);
    }

    return FromValidation(
        false,
        {},
        "Unsupported custom model category: " + category
    );
}

CustomModelPathRequirements GetCustomModelPathRequirements(
    const std::string& category,
    const std::string& modelType
) {
    const std::string cat = ToLower(category);

    if (cat == "stt") {
        const SttModelKind kind = ParseSttModelType(modelType);
        if (kind == SttModelKind::kUnknown) return {};
        return FromSpecs(GetSttPathRequirements(kind));
    }
    if (cat == "stt_streaming") {
        const OnlineSttModelKind kind = ParseOnlineSttModelType(modelType);
        if (kind == OnlineSttModelKind::kUnknown) return {};
        return FromSpecs(GetOnlineSttPathRequirements(kind));
    }
    if (cat == "tts") {
        const TtsModelKind kind = ParseTtsModelTypeLocal(modelType);
        if (kind == TtsModelKind::kUnknown) return {};
        return FromSpecs(GetTtsPathRequirements(kind));
    }
    if (cat == "vad") {
        const VadModelKind kind = ParseVadModelTypeLocal(modelType);
        if (kind == VadModelKind::kUnknown) return {};
        return FromSpecs(GetVadPathRequirements(kind));
    }
    if (cat == "enhancement") {
        const EnhancementModelKind kind = ParseEnhancementModelTypeLocal(modelType);
        if (kind == EnhancementModelKind::kUnknown) return {};
        return FromSpecs(GetEnhancementPathRequirements(kind));
    }
    if (cat == "separation") {
        const SeparationModelKind kind = ParseSeparationModelTypeLocal(modelType);
        if (kind == SeparationModelKind::kUnknown) return {};
        return FromSpecs(GetSeparationPathRequirements(kind));
    }
    if (cat == "speakerembedding" || cat == "speaker_embedding") {
        const SpeakerEmbeddingModelKind kind =
            ParseSpeakerEmbeddingModelTypeLocal(modelType);
        if (kind == SpeakerEmbeddingModelKind::kUnknown) return {};
        return FromSpecs(GetSpeakerEmbeddingPathRequirements(kind));
    }
    if (cat == "punctuation") {
        const PunctuationModelKind kind = ParsePunctuationModelTypeLocal(modelType);
        if (kind == PunctuationModelKind::kUnknown) return {};
        return FromSpecs(GetPunctuationPathRequirements(kind));
    }
    if (cat == "alignment") {
        const AlignmentModelKind kind = ParseAlignmentModelTypeLocal(modelType);
        if (kind == AlignmentModelKind::kUnknown) return {};
        return FromSpecs(GetAlignmentPathRequirements(kind));
    }

    return {};
}

}  // namespace sherpaonnx
