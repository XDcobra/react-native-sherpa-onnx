/**
 * sherpa-onnx-stt-catalog-metadata.cpp
 *
 * Thin STT-specific wrapper around shared catalog metadata heuristics.
 */
#include "sherpa-onnx-stt-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillSttDerivedCatalogMetadata(SttDetectResult& r, const std::string& idForHeuristics) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadata(r.derivedLanguages, r.quantization, ignoredSizeTier, idForHeuristics);
}

void FillSttDerivedCatalogMetadataUsingModelDirBasename(SttDetectResult& r, const std::string& modelDir) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(r.derivedLanguages, r.quantization, ignoredSizeTier, modelDir);
}

} // namespace sherpaonnx
