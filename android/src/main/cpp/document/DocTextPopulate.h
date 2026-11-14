#pragma once

#include "DocTypes.h"

#include <string>

namespace sherpa_onnx {
namespace document {

/**
 * Fills an empty offline text buffer with an extraction result: text, markup
 * spans (`origin: "markup"`) and, when present, the reading structure.
 * Shared by the iOS and Android bridges so both store the same data.
 * @return false (with `error`) if the buffer is unknown or already populated.
 */
bool PopulateTextBufferFromDocument(const std::string& bufferId,
                                    const ExtractTextResult& result,
                                    std::string* error);

}  // namespace document
}  // namespace sherpa_onnx
