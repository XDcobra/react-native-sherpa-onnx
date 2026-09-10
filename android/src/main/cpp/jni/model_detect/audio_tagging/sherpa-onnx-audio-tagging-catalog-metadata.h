#ifndef SHERPA_ONNX_AUDIO_TAGGING_CATALOG_METADATA_H
#define SHERPA_ONNX_AUDIO_TAGGING_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx {

/** Heuristic languages / quantization from a catalog id or folder basename (no filesystem). */
void FillAudioTaggingDerivedCatalogMetadata(
    AudioTaggingDetectResult& r,
    const std::string& idForHeuristics
);

/** Same as FillAudioTaggingDerivedCatalogMetadata using the last path segment of modelDir. */
void FillAudioTaggingDerivedCatalogMetadataUsingModelDirBasename(
    AudioTaggingDetectResult& r,
    const std::string& modelDir
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_AUDIO_TAGGING_CATALOG_METADATA_H
