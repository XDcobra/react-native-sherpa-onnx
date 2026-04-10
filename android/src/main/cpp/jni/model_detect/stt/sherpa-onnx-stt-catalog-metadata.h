#ifndef SHERPA_ONNX_STT_CATALOG_METADATA_H
#define SHERPA_ONNX_STT_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx {

/** Heuristic languages / quantization from a catalog id or folder basename (no filesystem). */
void FillSttDerivedCatalogMetadata(SttDetectResult& r, const std::string& idForHeuristics);

/** Same as FillSttDerivedCatalogMetadata using the last path segment of modelDir. */
void FillSttDerivedCatalogMetadataUsingModelDirBasename(SttDetectResult& r, const std::string& modelDir);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_STT_CATALOG_METADATA_H
