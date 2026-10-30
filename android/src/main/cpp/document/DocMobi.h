#pragma once

#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

/** MOBI / PRC / AZW / AZW3 (KF8) without DRM. PalmDOC + HUFF/CDIC + HTML. */
ExtractTextResult ExtractMobiText(const DocumentSource& src,
                                  const ExtractOptions& opt);
ExtractImagesResult ExtractMobiImages(const DocumentSource& src,
                                      const ExtractOptions& opt);

}  // namespace document
}  // namespace sherpa_onnx
