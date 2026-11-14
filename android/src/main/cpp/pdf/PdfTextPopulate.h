#pragma once

#include "PdfTypes.h"

#include <string>

namespace sherpa_onnx {
namespace pdf {

/**
 * Fills an empty offline text buffer with a text layer result: text, line
 * spans (`origin: "textLayer"`, page number and size) and, for the paragraphs
 * layout, the reading structure (spans then also carry the page's section
 * index and `page:N` href). Shared by the iOS and Android bridges.
 * @return false (with `error`) if the buffer is unknown or already populated.
 */
bool PopulateTextFromPdf(const std::string& text_buffer_id, const PdfTextLayerResult& result,
                         std::string* error);

}  // namespace pdf
}  // namespace sherpa_onnx
