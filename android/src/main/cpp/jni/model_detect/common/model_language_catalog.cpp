#include "model_language_catalog.h"

#include "model_language_catalog.inc.h"

#include <algorithm>

namespace sherpaonnx {
namespace {

const char* TtsKindToModelType(TtsModelKind kind) {
    switch (kind) {
        case TtsModelKind::kVits: return "vits";
        case TtsModelKind::kMatcha: return "matcha";
        case TtsModelKind::kKokoro: return "kokoro";
        case TtsModelKind::kKitten: return "kitten";
        case TtsModelKind::kPocket: return "pocket";
        case TtsModelKind::kZipvoice: return "zipvoice";
        case TtsModelKind::kSupertonic: return "supertonic";
        default: return "";
    }
}

const char* SttKindToModelType(SttModelKind kind) {
    switch (kind) {
        case SttModelKind::kSenseVoice: return "sense_voice";
        case SttModelKind::kWhisper: return "whisper";
        case SttModelKind::kFunAsrNano: return "funasr_nano";
        case SttModelKind::kQwen3Asr: return "qwen3_asr";
        case SttModelKind::kCohereTranscribe: return "cohere_transcribe";
        case SttModelKind::kMoonshine: return "moonshine";
        case SttModelKind::kMoonshineV2: return "moonshine_v2";
        case SttModelKind::kDolphin: return "dolphin";
        case SttModelKind::kCanary: return "canary";
        default: return "";
    }
}

void AppendUniqueRows(
    std::vector<PublicLanguageRow>& derivedLanguages,
    const std::vector<PublicLanguageRow>& rows) {
    for (const auto& row : rows) {
        if (row.iso6391Hint.empty()) {
            continue;
        }
        const auto it = std::find_if(
            derivedLanguages.begin(),
            derivedLanguages.end(),
            [&row](const PublicLanguageRow& existing) {
                return existing.iso6391Hint == row.iso6391Hint &&
                       existing.id == row.id;
            });
        if (it == derivedLanguages.end()) {
            derivedLanguages.push_back(row);
        }
    }
}

const std::vector<PublicLanguageRow>& CuratedRows(
    ModelLanguageDomain domain,
    const std::string& modelType,
    const std::string& modelKey) {
    using namespace model_language_catalog;
    if (domain == ModelLanguageDomain::kTts) {
        if (modelType == "supertonic") {
            return TtsSupertonicRows(modelKey);
        }
        return TtsSimpleRows(modelType);
    }
    return SttRowsForModelType(modelType);
}

} // namespace

void UpgradeModelOptionIdsForType(
    const std::string& modelType,
    std::vector<PublicLanguageRow>& derivedLanguages) {
    if (modelType.empty()) {
        return;
    }
    for (auto& row : derivedLanguages) {
        row.id = model_language_catalog::ModelOptionIdForHint(modelType, row.iso6391Hint);
    }
}

void AppendCuratedLanguageRowsIfEmpty(
    ModelLanguageDomain domain,
    const std::string& modelType,
    const std::string& modelKey,
    bool detectOk,
    bool nameOnly,
    std::vector<PublicLanguageRow>& derivedLanguages,
    std::vector<DetectionSource>& detectionSources) {
    if (!derivedLanguages.empty() || modelType.empty()) {
        return;
    }
    if (!detectOk && !nameOnly) {
        return;
    }
    const auto& rows = CuratedRows(domain, modelType, modelKey);
    if (rows.empty()) {
        return;
    }
    AppendUniqueRows(derivedLanguages, rows);
    if (!derivedLanguages.empty()) {
        detectionSources.push_back(DetectionSource::kCuratedCatalog);
    }
}

namespace {

bool HasNameOnlySource(const std::vector<DetectionSource>& sources) {
    return std::find(sources.begin(), sources.end(), DetectionSource::kNameOnly) !=
           sources.end();
}

} // namespace

void AppendCuratedTtsLanguageRowsIfEmpty(
    TtsDetectResult& result,
    const std::string& modelKey) {
    const char* modelType = TtsKindToModelType(result.selectedKind);
    if (modelType[0] == '\0') {
        return;
    }
    UpgradeModelOptionIdsForType(modelType, result.derivedLanguages);
    AppendCuratedLanguageRowsIfEmpty(
        ModelLanguageDomain::kTts,
        modelType,
        modelKey,
        result.ok,
        HasNameOnlySource(result.detectionSources),
        result.derivedLanguages,
        result.detectionSources);
}

void AppendCuratedSttLanguageRowsIfEmpty(
    SttDetectResult& result,
    const std::string& modelKey) {
    const char* modelType = SttKindToModelType(result.selectedKind);
    if (modelType[0] == '\0') {
        return;
    }
    UpgradeModelOptionIdsForType(modelType, result.derivedLanguages);
    AppendCuratedLanguageRowsIfEmpty(
        ModelLanguageDomain::kStt,
        modelType,
        modelKey,
        result.ok,
        HasNameOnlySource(result.detectionSources),
        result.derivedLanguages,
        result.detectionSources);
}

} // namespace sherpaonnx
