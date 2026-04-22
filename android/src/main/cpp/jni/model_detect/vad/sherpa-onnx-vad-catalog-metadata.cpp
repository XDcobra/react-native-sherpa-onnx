#include "sherpa-onnx-vad-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillVadDerivedCatalogMetadata(VadDetectResult& r, const std::string& idForHeuristics) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadata(r.derivedLanguages, r.quantization, ignoredSizeTier, idForHeuristics);
}

void FillVadDerivedCatalogMetadataUsingModelDirBasename(VadDetectResult& r, const std::string& modelDir) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(r.derivedLanguages, r.quantization, ignoredSizeTier, modelDir);
}

} // namespace sherpaonnx
