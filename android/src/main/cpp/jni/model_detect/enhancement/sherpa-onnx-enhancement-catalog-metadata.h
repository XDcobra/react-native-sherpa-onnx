#ifndef SHERPA_ONNX_ENHANCEMENT_CATALOG_METADATA_H
#define SHERPA_ONNX_ENHANCEMENT_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx {

/** Heuristic languages / quantization from a catalog id or folder basename (no filesystem). */
void FillEnhancementDerivedCatalogMetadata(EnhancementDetectResult& r, const std::string& idForHeuristics);

/** Same as FillEnhancementDerivedCatalogMetadata using the last path segment of modelDir. */
void FillEnhancementDerivedCatalogMetadataUsingModelDirBasename(EnhancementDetectResult& r, const std::string& modelDir);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_ENHANCEMENT_CATALOG_METADATA_H
