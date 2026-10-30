#pragma once

#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

ExtractTextResult ExtractDocumentText(const DocumentSource& src,
                                      const ExtractOptions& opt = {});

ExtractImagesResult ExtractDocumentImages(const DocumentSource& src,
                                          const ExtractOptions& opt = {});

}  // namespace document
}  // namespace sherpa_onnx
