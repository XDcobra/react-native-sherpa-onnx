#pragma once

#include "OcrTypes.h"

#include <string>

namespace sherpa_onnx {
namespace ocr {

/**
 * Writes a recognize result into an empty offline text buffer (both
 * platforms): text, line/word/block spans with the source frame's page
 * number, section, href and video time, and the OCR layout (frame ranges,
 * elements) for the reader.
 * @return false with `error_code` OCR_ALREADY_POPULATED / OCR_INVALID_ARGUMENT.
 */
bool PopulateTextFromOcr(const std::string& text_buffer_id, const std::string& image_buffer_id,
                         const std::string& family, const OcrResult& result,
                         std::string* error_code, std::string* error_message);

}  // namespace ocr
}  // namespace sherpa_onnx
