/**
 * sherpa-onnx-tts-catalog-metadata.cpp
 *
 * Thin TTS-specific wrapper around the shared catalog metadata heuristics.
 * Delegates to common/sherpa-onnx-catalog-metadata for language/quantization/sizeTier derivation.
 */
#include "sherpa-onnx-tts-catalog-metadata.h"
#include "sherpa-onnx-catalog-metadata.h"

namespace sherpaonnx {

void FillTtsDerivedCatalogMetadata(TtsDetectResult& r, const std::string& idForHeuristics) {
    FillDerivedCatalogMetadata(r.derivedLanguages, r.quantization, r.sizeTier, idForHeuristics);
}

void FillTtsDerivedCatalogMetadataUsingModelDirBasename(TtsDetectResult& r, const std::string& modelDir) {
    FillDerivedCatalogMetadataFromBasename(r.derivedLanguages, r.quantization, r.sizeTier, modelDir);
}

} // namespace sherpaonnx
