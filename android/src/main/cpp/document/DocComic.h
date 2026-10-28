#pragma once

#include "DocArchive.h"
#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

ExtractImagesResult ExtractComicImages(ArchiveReader& ar, const char* format,
                                       const ExtractOptions& opt);

}  // namespace document
}  // namespace sherpa_onnx
