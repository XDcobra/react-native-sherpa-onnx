/**
 * sherpa-onnx-model-detect-unified.cpp
 *
 * Unified model detection: runs domain detectors in fixed order (first hit wins).
 */
#include "sherpa-onnx-model-detect-unified.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-path-fill.h"

#include <algorithm>

namespace sherpaonnx {
namespace {

const char* kModelTypeAuto = "auto";

bool HasDetectInput(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name) {
    const bool hasDir = model_dir.has_value() && !model_dir->empty();
    const bool hasAsset = asset_name.has_value() && !asset_name->empty();
    return hasDir || hasAsset;
}

const char* TtsModelKindToString(TtsModelKind k) {
    switch (k) {
        case TtsModelKind::kVits: return "vits";
        case TtsModelKind::kMatcha: return "matcha";
        case TtsModelKind::kKokoro: return "kokoro";
        case TtsModelKind::kKitten: return "kitten";
        case TtsModelKind::kPocket: return "pocket";
        case TtsModelKind::kZipvoice: return "zipvoice";
        case TtsModelKind::kSupertonic: return "supertonic";
        default: return "unknown";
    }
}

const char* SttModelKindToString(SttModelKind k) {
    switch (k) {
        case SttModelKind::kTransducer: return "transducer";
        case SttModelKind::kNemoTransducer: return "nemo_transducer";
        case SttModelKind::kParaformer: return "paraformer";
        case SttModelKind::kNemoCtc: return "nemo_ctc";
        case SttModelKind::kWenetCtc: return "wenet_ctc";
        case SttModelKind::kSenseVoice: return "sense_voice";
        case SttModelKind::kZipformerCtc: return "zipformer_ctc";
        case SttModelKind::kWhisper: return "whisper";
        case SttModelKind::kFunAsrNano: return "funasr_nano";
        case SttModelKind::kQwen3Asr: return "qwen3_asr";
        case SttModelKind::kCohereTranscribe: return "cohere_transcribe";
        case SttModelKind::kFireRedAsr: return "fire_red_asr";
        case SttModelKind::kMoonshine: return "moonshine";
        case SttModelKind::kMoonshineV2: return "moonshine_v2";
        case SttModelKind::kDolphin: return "dolphin";
        case SttModelKind::kCanary: return "canary";
        case SttModelKind::kOmnilingual: return "omnilingual";
        case SttModelKind::kMedAsr: return "medasr";
        case SttModelKind::kTeleSpeechCtc: return "telespeech_ctc";
        case SttModelKind::kToneCtc: return "tone_ctc";
        default: return "unknown";
    }
}

const char* VadModelKindToString(VadModelKind k) {
    switch (k) {
        case VadModelKind::kSileroVad: return "silero_vad";
        case VadModelKind::kTenVad: return "ten_vad";
        default: return "unknown";
    }
}

const char* PunctuationModelKindToString(PunctuationModelKind k) {
    switch (k) {
        case PunctuationModelKind::kCtTransformer: return "ct_transformer";
        case PunctuationModelKind::kCnnBilstm: return "cnn_bilstm";
        default: return "unknown";
    }
}

const char* EnhancementModelKindToString(EnhancementModelKind k) {
    switch (k) {
        case EnhancementModelKind::kGtcrn: return "gtcrn";
        case EnhancementModelKind::kDpdfNet: return "dpdfnet";
        default: return "unknown";
    }
}

const char* AlignmentModelKindToString(AlignmentModelKind k) {
    switch (k) {
        case AlignmentModelKind::kWav2Vec2: return "wav2vec2";
        default: return "unknown";
    }
}

void CopyDetectionSources(
    UnifiedModelDetectResult& out,
    const std::vector<DetectionSource>& sources) {
    out.detectionSources.clear();
    out.detectionSources.reserve(sources.size());
    for (DetectionSource s : sources) {
        out.detectionSources.emplace_back(DetectionSourceToLiteral(s));
    }
}

bool IsHit(const std::string& modelType) {
    return !modelType.empty() && modelType != "unknown";
}

bool HasNameOnlyDetectionSource(const std::vector<DetectionSource>& sources) {
    return std::find(sources.begin(), sources.end(), DetectionSource::kNameOnly) !=
           sources.end();
}

/** Full file scan: ok=true. Name-only catalog hints: ok=false but kind inferred. */
bool IsCatalogDetectHit(
    bool ok,
    const std::string& modelType,
    const std::vector<DetectionSource>& sources) {
    if (!IsHit(modelType)) {
        return false;
    }
    if (ok) {
        return true;
    }
    return HasNameOnlyDetectionSource(sources);
}

UnifiedModelDetectResult MakeHit(
    const char* category,
    const std::string& modelType,
    const std::vector<std::string>& languages,
    const std::string& quantization,
    const std::string& sizeTier,
    bool isStreaming,
    bool isHardwareSpecificUnsupported,
    const std::vector<DetectedModel>& detectedModels,
    const std::vector<DetectionSource>& detectionSources,
    const std::map<std::string, std::string>& paths,
    const std::string& error) {
    UnifiedModelDetectResult out;
    out.matched = true;
    out.category = category;
    out.success = true;
    out.modelType = modelType;
    out.languages = languages;
    out.quantization = quantization;
    out.sizeTier = sizeTier;
    out.isStreaming = isStreaming;
    out.isHardwareSpecificUnsupported = isHardwareSpecificUnsupported;
    out.detectedModels = detectedModels;
    CopyDetectionSources(out, detectionSources);
    out.paths = paths;
    out.error = error;
    return out;
}

UnifiedModelDetectResult DetectModelInternal(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name) {
    UnifiedModelDetectResult miss;
    if (!HasDetectInput(model_dir, asset_name)) {
        return miss;
    }

    const std::string modelType = kModelTypeAuto;

    TtsDetectResult tts = DetectTtsModel(model_dir, asset_name, modelType);
    const std::string ttsType = TtsModelKindToString(tts.selectedKind);
    if (IsCatalogDetectHit(tts.ok, ttsType, tts.detectionSources)) {
        return MakeHit(
            "tts",
            ttsType,
            tts.derivedLanguages,
            tts.quantization,
            tts.sizeTier,
            true,
            false,
            tts.detectedModels,
            tts.detectionSources,
            TtsModelPathsToStringMap(tts.paths),
            tts.error);
    }

    SttDetectResult stt = DetectSttModel(
        model_dir, asset_name, modelType, std::nullopt, false);
    const std::string sttType = SttModelKindToString(stt.selectedKind);
    if (IsCatalogDetectHit(stt.ok, sttType, stt.detectionSources)) {
        return MakeHit(
            "stt",
            sttType,
            stt.derivedLanguages,
            stt.quantization,
            "",
            stt.isStreaming,
            stt.isHardwareSpecificUnsupported,
            stt.detectedModels,
            stt.detectionSources,
            SttModelPathsToStringMap(stt.paths),
            stt.error);
    }

    VadDetectResult vad = DetectVadModel(model_dir, asset_name, modelType);
    const std::string vadType = VadModelKindToString(vad.selectedKind);
    if (IsCatalogDetectHit(vad.ok, vadType, vad.detectionSources)) {
        return MakeHit(
            "vad",
            vadType,
            vad.derivedLanguages,
            vad.quantization,
            "",
            vad.isStreaming,
            false,
            vad.detectedModels,
            vad.detectionSources,
            VadModelPathsToStringMap(vad.paths),
            vad.error);
    }

    PunctuationDetectResult punctuation =
        DetectPunctuationModel(model_dir, asset_name, modelType);
    const std::string punctuationType =
        PunctuationModelKindToString(punctuation.selectedKind);
    if (IsCatalogDetectHit(
            punctuation.ok, punctuationType, punctuation.detectionSources)) {
        return MakeHit(
            "punctuation",
            punctuationType,
            punctuation.derivedLanguages,
            punctuation.quantization,
            "",
            punctuation.isStreaming,
            false,
            punctuation.detectedModels,
            punctuation.detectionSources,
            PunctuationModelPathsToStringMap(punctuation.paths),
            punctuation.error);
    }

    EnhancementDetectResult enhancement =
        DetectEnhancementModel(model_dir, asset_name, modelType);
    const std::string enhancementType =
        EnhancementModelKindToString(enhancement.selectedKind);
    if (IsCatalogDetectHit(
            enhancement.ok, enhancementType, enhancement.detectionSources)) {
        return MakeHit(
            "enhancement",
            enhancementType,
            enhancement.derivedLanguages,
            enhancement.quantization,
            "",
            enhancement.isStreaming,
            false,
            enhancement.detectedModels,
            enhancement.detectionSources,
            EnhancementModelPathsToStringMap(enhancement.paths),
            enhancement.error);
    }

    std::string alignmentKey;
    if (model_dir.has_value() && !model_dir->empty()) {
        alignmentKey = *model_dir;
    } else if (asset_name.has_value() && !asset_name->empty()) {
        alignmentKey = *asset_name;
    }
    if (!alignmentKey.empty()) {
        AlignmentDetectResult alignment =
            DetectAlignmentModel(alignmentKey, modelType);
        const std::string alignmentType =
            AlignmentModelKindToString(alignment.selectedKind);
        if (IsCatalogDetectHit(
                alignment.ok, alignmentType, alignment.detectionSources)) {
            return MakeHit(
                "alignment",
                alignmentType,
                alignment.derivedLanguages,
                alignment.quantization,
                "",
                false,
                false,
                alignment.detectedModels,
                alignment.detectionSources,
                AlignmentModelPathsToStringMap(alignment.paths),
                alignment.error);
        }
    }

    return miss;
}

}  // namespace

UnifiedModelDetectResult DetectModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name) {
    return DetectModelInternal(model_dir, asset_name);
}

std::vector<UnifiedModelDetectResult> DetectModelsBatch(
    const std::vector<UnifiedModelDetectInput>& inputs) {
    std::vector<UnifiedModelDetectResult> results;
    results.reserve(inputs.size());
    for (const auto& input : inputs) {
        results.push_back(DetectModelInternal(input.model_dir, input.asset_name));
    }
    return results;
}

}  // namespace sherpaonnx
