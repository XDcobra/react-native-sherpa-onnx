#ifndef SHERPA_ONNX_TTS_CATALOG_METADATA_H
#define SHERPA_ONNX_TTS_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx {

/** Heuristic languages / quantization / sizeTier from a catalog id or folder basename (no filesystem). */
void FillTtsDerivedCatalogMetadata(TtsDetectResult& r, const std::string& idForHeuristics);

/** Same as FillTtsDerivedCatalogMetadata using the last path segment of modelDir. */
void FillTtsDerivedCatalogMetadataUsingModelDirBasename(TtsDetectResult& r, const std::string& modelDir);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_TTS_CATALOG_METADATA_H
