#pragma once

#include "PdfTypes.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace pdf {

struct ExtractOptions {
  /** Empty = all pages. Otherwise 1-based page indices. */
  std::vector<int> pages;
  std::function<bool()> is_cancelled;
  std::function<void(int done, int total, const char* phase)> on_progress;
};

/**
 * Extract digital PDF text layer into UTF-16 text + spatial spans.
 * When PDFium is not compiled in, returns ERR_PDF_PDFIUM_DISABLED.
 */
PdfTextLayerResult ExtractPdfTextLayer(
    const uint8_t* pdf_bytes,
    size_t pdf_size,
    const ExtractOptions& options = {});

}  // namespace pdf
}  // namespace sherpa_onnx
