/**
 * sherpa-onnx-enhancement-catalog-metadata.cpp
 *
 * Thin enhancement-specific wrapper around shared catalog metadata heuristics.
 */
#include "sherpa-onnx-enhancement-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillEnhancementDerivedCatalogMetadata(EnhancementDetectResult& r, const std::string& idForHeuristics) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadata(r.derivedLanguages, r.quantization, ignoredSizeTier, idForHeuristics);
}

void FillEnhancementDerivedCatalogMetadataUsingModelDirBasename(EnhancementDetectResult& r, const std::string& modelDir) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(r.derivedLanguages, r.quantization, ignoredSizeTier, modelDir);
}

} // namespace sherpaonnx
