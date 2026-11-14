#pragma once

#include "PdfTypes.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace pdf {

enum class PdfTextLayout {
  /** One line per text line, joined by "\n" (default). */
  kLines,
  /**
   * Reading text: paragraphs, headings, one section per page and the book's
   * contents (see PdfStructureBuilder.h). A page without text becomes a
   * section with only its page block, so scan-only PDFs succeed too
   * (`pages_with_text == 0`).
   */
  kParagraphs,
};

struct ExtractOptions {
  /** Empty = all pages. Otherwise 1-based page indices. */
  std::vector<int> pages;
  /** User or owner password. Empty = none. */
  std::string password;
  PdfTextLayout layout = PdfTextLayout::kLines;
  std::function<bool()> is_cancelled;
  std::function<void(int done, int total, const char* phase)> on_progress;
};

/**
 * Extract digital PDF text layer into UTF-16 text + spatial spans.
 * When PDFium is not compiled in, returns ERR_PDF_PDFIUM_DISABLED.
 */
PdfTextLayerResult ExtractPdfTextLayer(
    const PdfSource& src,
    const ExtractOptions& options = {});

}  // namespace pdf
}  // namespace sherpa_onnx
