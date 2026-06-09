#ifndef SHERPA_ONNX_CATALOG_METADATA_H
#define SHERPA_ONNX_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"

#include <string>
#include <vector>

namespace sherpaonnx {

/** Common catalog heuristics (no filesystem). Shared by TTS, Alignment, and future features. */

/** Get the last path component (basename) from a path string. */
std::string BasenameLastPathComponent(const std::string& path);

/** Derive quantization hint (fp16, int8, int8-quantized, unknown) from a model id/name string. */
std::string DeriveQuantization(const std::string& id);

/** Derive size tier hint (tiny, small, medium, large, unknown) from a model id/name string. */
std::string DeriveSizeTier(const std::string& id);

/** Derive language hints (ISO 639-1 tags) from a model id/name string. */
std::vector<std::string> DeriveLanguagesFromModelId(const std::string& id);

/**
 * Fill derived catalog metadata (languages, quantization, sizeTier) into separate output args.
 * Generic version used by all features.
 */
void FillDerivedCatalogMetadata(
    std::vector<PublicLanguageRow>& outLanguages,
    std::string& outQuantization,
    std::string& outSizeTier,
    const std::string& idForHeuristics
);

/**
 * Same as FillDerivedCatalogMetadata but uses the last path segment of a directory path.
 */
void FillDerivedCatalogMetadataFromBasename(
    std::vector<PublicLanguageRow>& outLanguages,
    std::string& outQuantization,
    std::string& outSizeTier,
    const std::string& dirPath
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_CATALOG_METADATA_H
