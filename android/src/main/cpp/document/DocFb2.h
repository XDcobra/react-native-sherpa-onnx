#pragma once

#include "DocArchive.h"
#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

ExtractTextResult ExtractFb2Text(const DocumentSource& src, ArchiveReader* zip,
                                 const ExtractOptions& opt);
ExtractImagesResult ExtractFb2Images(const DocumentSource& src, ArchiveReader* zip,
                                     const ExtractOptions& opt);

}  // namespace document
}  // namespace sherpa_onnx
