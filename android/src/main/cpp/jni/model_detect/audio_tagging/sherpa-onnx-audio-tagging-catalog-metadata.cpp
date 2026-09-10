/**
 * sherpa-onnx-audio-tagging-catalog-metadata.cpp
 *
 * Thin audio-tagging-specific wrapper around shared catalog metadata heuristics.
 */
#include "sherpa-onnx-audio-tagging-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillAudioTaggingDerivedCatalogMetadata(
    AudioTaggingDetectResult& r,
    const std::string& idForHeuristics
) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadata(
        r.derivedLanguages, r.quantization, ignoredSizeTier, idForHeuristics);
}

void FillAudioTaggingDerivedCatalogMetadataUsingModelDirBasename(
    AudioTaggingDetectResult& r,
    const std::string& modelDir
) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(
        r.derivedLanguages, r.quantization, ignoredSizeTier, modelDir);
}

} // namespace sherpaonnx
