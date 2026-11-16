#pragma once

#include "DocArchive.h"
#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

/**
 * Comic pages in natural name order. With `opt.lazy` the pages stay in the
 * archive: frames carry a loader and the decoded size from the headers.
 */
ExtractImagesResult ExtractComicImages(const DocumentSource& src, ArchiveReader& ar,
                                       const char* format, const ExtractOptions& opt);

}  // namespace document
}  // namespace sherpa_onnx
