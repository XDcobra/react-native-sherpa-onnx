#ifndef SHERPA_ONNX_MODEL_LANGUAGE_CATALOG_H
#define SHERPA_ONNX_MODEL_LANGUAGE_CATALOG_H

#include "sherpa-onnx-model-detect.h"

#include <string>
#include <vector>

namespace sherpaonnx {

enum class ModelLanguageDomain {
    kTts,
    kStt,
    kAlignment,
    kOcr,
    kSpeakerEmbedding,
};

/**
 * When folder/name heuristics left derivedLanguages empty, append curated catalog rows
 * for (domain, modelType, modelKey). Does nothing when derivedLanguages is non-empty or
 * detect did not succeed.
 */
void AppendCuratedLanguageRowsIfEmpty(
    ModelLanguageDomain domain,
    const std::string& modelType,
    const std::string& modelKey,
    bool detectOk,
    bool nameOnly,
    std::vector<PublicLanguageRow>& derivedLanguages,
    std::vector<DetectionSource>& detectionSources);

/** Upgrade heuristic row ids using catalog hint→id mapping when modelType is known. */
void UpgradeModelOptionIdsForType(
    const std::string& modelType,
    std::vector<PublicLanguageRow>& derivedLanguages);

void AppendCuratedTtsLanguageRowsIfEmpty(
    TtsDetectResult& result,
    const std::string& modelKey);

void AppendCuratedSttLanguageRowsIfEmpty(
    SttDetectResult& result,
    const std::string& modelKey);

void AppendCuratedAlignmentLanguageRowsIfEmpty(
    AlignmentDetectResult& result,
    const std::string& modelKey);

void AppendCuratedOcrLanguageRowsIfEmpty(
    OcrDetectResult& result,
    const std::string& modelKey);

/**
 * When a curated speaker-embedding pack match exists for modelKey, replace
 * derivedLanguages (heuristics can mis-tag "sv" / "cn"). No-op when no match.
 */
void ApplyCuratedSpeakerEmbeddingLanguageRows(
    SpeakerEmbeddingDetectResult& result,
    const std::string& modelKey);

/**
 * When a curated diarization pack match exists for modelKey, replace
 * derivedLanguages (same pattern as speaker embedding). No-op when no match —
 * language-agnostic packs simply have no catalog entry.
 */
void ApplyCuratedDiarizationLanguageRows(
    DiarizationDetectResult& result,
    const std::string& modelKey);

} // namespace sherpaonnx

#endif
