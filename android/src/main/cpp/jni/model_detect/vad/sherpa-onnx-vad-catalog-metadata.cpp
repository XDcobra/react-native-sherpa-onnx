#include "sherpa-onnx-vad-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillVadDerivedCatalogMetadata(VadDetectResult& r, const std::string& idForHeuristics) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadata(r.derivedLanguages, r.quantization, ignoredSizeTier, idForHeuristics);
    // Works on the sound, not on a spoken language: name tokens such as
    // "_hr" (high resolution) must not become language codes.
    r.derivedLanguages.clear();
}

void FillVadDerivedCatalogMetadataUsingModelDirBasename(VadDetectResult& r, const std::string& modelDir) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(r.derivedLanguages, r.quantization, ignoredSizeTier, modelDir);
    // Works on the sound, not on a spoken language: name tokens such as
    // "_hr" (high resolution) must not become language codes.
    r.derivedLanguages.clear();
}

} // namespace sherpaonnx
