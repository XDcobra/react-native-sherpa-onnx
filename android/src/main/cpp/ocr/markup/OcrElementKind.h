/**
 * Closed element-kind vocabulary + total maps from DocTags tags and Nemotron
 * class tokens. Unknown tags fail with OCR_PARSE_UNKNOWN_KIND (no fallback).
 */
#pragma once

#include "OcrInstruction.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace sherpa_onnx {
namespace ocr {

enum class OcrElementKind : uint8_t {
  kText = 0,
  kTitle,
  kSectionHeader,
  kListItem,
  kCaption,
  kFootnote,
  kPageHeader,
  kPageFooter,
  kPicture,
  kFormula,
  kCode,
  kTable,
  kChart,
  kToc,
  kBibliography,
  kCheckbox,
  kForm,
  kKeyValue,
};

struct OcrElementKindParse {
  bool ok = false;
  OcrElementKind kind = OcrElementKind::kText;
  std::optional<int> level;
  std::optional<bool> checked;
  std::string error_code;
  std::string error_message;
};

OcrElementKindParse FromDocTagsTag(std::string_view tag);
OcrElementKindParse FromNemotronClass(std::string_view class_token);

const char* OcrElementKindName(OcrElementKind kind);

}  // namespace ocr
}  // namespace sherpa_onnx
