#ifndef SHERPA_ONNX_VAD_CATALOG_METADATA_H
#define SHERPA_ONNX_VAD_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx {

void FillVadDerivedCatalogMetadata(VadDetectResult& r, const std::string& idForHeuristics);
void FillVadDerivedCatalogMetadataUsingModelDirBasename(VadDetectResult& r, const std::string& modelDir);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VAD_CATALOG_METADATA_H
