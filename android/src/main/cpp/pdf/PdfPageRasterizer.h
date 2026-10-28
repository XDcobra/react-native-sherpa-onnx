#pragma once

#include "PdfDocument.h"
#include "PdfTypes.h"

#include "ImageTypes.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace pdf {

struct RasterOptions {
  /** Empty = all pages. Otherwise 1-based page indices. */
  std::vector<int> pages;
  /** Render DPI (default 144). Must be > 0. */
  int dpi = 144;
  /** Longest-edge cap after DPI scale (default 4096). <= 0 disables. */
  int max_side = 4096;
  /** User or owner password. Empty = none. */
  std::string password;
  std::function<bool()> is_cancelled;
  std::function<void(int done, int total, const char* phase)> on_progress;
};

struct PdfRasterResult {
  bool ok = false;
  std::string error_code;
  std::string error_message;
  int page_count = 0;
  std::vector<image::RgbFrame> frames;
};

/**
 * Rasterize a single 1-based page from an open document into packed RGB8.
 * Sets pageNumber / dpi on the frame. Thread-safe w.r.t. other pages if caller
 * serializes access to the same FPDF_DOCUMENT (PdfLazySession holds a mutex).
 */
bool RasterizePdfPage(
    const PdfDocument& doc,
    int page_1based,
    int dpi,
    int max_side,
    image::RgbFrame* out,
    std::string* err_code,
    std::string* err_message);

/**
 * Rasterize PDF pages to packed RGB8 frames (top-left, y-down).
 * Each frame has pageNumber (1-based) and dpi set.
 * When PDFium is not compiled in, returns ERR_PDF_PDFIUM_DISABLED.
 */
PdfRasterResult RasterizePdfPages(
    const PdfSource& src,
    const RasterOptions& options = {});

}  // namespace pdf
}  // namespace sherpa_onnx
