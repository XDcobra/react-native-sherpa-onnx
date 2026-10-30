/**
 * OTSL cell-token stream → OcrTable. Shared by Granite DocTags and Paddle table.
 */
#pragma once

#include "OcrTable.h"

#include <string>
#include <string_view>

namespace sherpa_onnx {
namespace ocr {

inline bool IsOtslCellToken(std::string_view tag) {
  return tag == "fcel" || tag == "ched" || tag == "rhed" || tag == "ecel" ||
         tag == "lcel" || tag == "ucel" || tag == "xcel" || tag == "nl" ||
         tag == "srow";
}

inline bool IsOtslContentCell(std::string_view tag) {
  return tag == "fcel" || tag == "ched" || tag == "rhed";
}

/**
 * Parse a raw OTSL token stream (`<fcel>…<nl>…`). Optional wrapping
 * `<otsl>…</otsl>` is ignored. Unknown tags are skipped (not errors).
 */
OcrTable ParseOtsl(const std::string& raw);

}  // namespace ocr
}  // namespace sherpa_onnx
