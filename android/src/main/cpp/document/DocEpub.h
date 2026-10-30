#pragma once

#include "DocArchive.h"
#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

ExtractTextResult ExtractEpubText(ArchiveReader& ar, const ExtractOptions& opt);
ExtractImagesResult ExtractEpubImages(ArchiveReader& ar,
                                      const ExtractOptions& opt);

}  // namespace document
}  // namespace sherpa_onnx
