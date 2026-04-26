#ifndef SHERPA_ONNX_PUNCTUATION_CATALOG_METADATA_H
#define SHERPA_ONNX_PUNCTUATION_CATALOG_METADATA_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx {

void FillPunctuationDerivedCatalogMetadata(PunctuationDetectResult& r, const std::string& idForHeuristics);

void FillPunctuationDerivedCatalogMetadataUsingModelDirBasename(
    PunctuationDetectResult& r,
    const std::string& modelDir
);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_PUNCTUATION_CATALOG_METADATA_H
