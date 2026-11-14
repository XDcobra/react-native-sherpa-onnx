#pragma once

#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

ExtractTextResult ExtractDocumentText(const DocumentSource& src,
                                      const ExtractOptions& opt = {});

ExtractImagesResult ExtractDocumentImages(const DocumentSource& src,
                                          const ExtractOptions& opt = {});

/**
 * Container format by content, not extension: "epub" | "fb2" | "mobi" (also
 * AZW3) | "cbz" | "cbr" | "pdf"; "" when unrecognized (no error) or when the
 * file cannot be read (`err_code` set).
 */
std::string DetectDocumentFormat(const DocumentSource& src, std::string* err_code = nullptr,
                                 std::string* err_message = nullptr);

}  // namespace document
}  // namespace sherpa_onnx
