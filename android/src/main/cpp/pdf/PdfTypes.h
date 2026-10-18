#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace pdf {

/** Stable public error codes (JS / bridge). */
inline constexpr const char* kErrDisabled = "ERR_PDF_PDFIUM_DISABLED";
inline constexpr const char* kErrInvalidArgument = "ERR_PDF_INVALID_ARGUMENT";
inline constexpr const char* kErrOpenFailed = "ERR_PDF_OPEN_FAILED";
inline constexpr const char* kErrEncrypted = "ERR_PDF_ENCRYPTED";
inline constexpr const char* kErrNoTextLayer = "ERR_PDF_NO_TEXT_LAYER";
inline constexpr const char* kErrCancelled = "ERR_PDF_CANCELLED";
inline constexpr const char* kErrInternal = "ERR_PDF_INTERNAL";

struct PdfTextSpan {
  int utf16_start = 0;
  int utf16_end = 0;
  std::string level = "line";  // line | word | block
  /** Empty for textLayer (no ImageBuffer). */
  std::string source_image_buffer_id;
  int frame_index = 0;
  /** Top-left origin, y-down, PDF user-space after native normalize. */
  float quad[8] = {};
  int page_number = 1;  // 1-based
  float page_width = 0.f;
  float page_height = 0.f;
};

struct PdfTextLayerResult {
  bool ok = false;
  std::string error_code;
  std::string error_message;
  std::string text;
  std::vector<PdfTextSpan> spans;
  int page_count = 0;
  int pages_with_text = 0;
};

}  // namespace pdf
}  // namespace sherpa_onnx
