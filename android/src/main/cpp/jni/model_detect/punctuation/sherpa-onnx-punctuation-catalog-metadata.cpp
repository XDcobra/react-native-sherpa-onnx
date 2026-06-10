#include "sherpa-onnx-punctuation-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillPunctuationDerivedCatalogMetadata(PunctuationDetectResult& r, const std::string& idForHeuristics) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadata(r.derivedLanguages, r.quantization, ignoredSizeTier, idForHeuristics);
}

void FillPunctuationDerivedCatalogMetadataUsingModelDirBasename(
    PunctuationDetectResult& r,
    const std::string& modelDir
) {
    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(r.derivedLanguages, r.quantization, ignoredSizeTier, modelDir);
}

}  // namespace sherpaonnx
