#pragma once

#include "PdfDocument.h"
#include "PdfTypes.h"

#include "ImageTypes.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace pdf {

/**
 * Retained PDFium document for lazy-lru OfflineImageBuffer slots.
 * Owns PDF bytes (FPDF_LoadMemDocument requires lifetime) + open doc.
 * Thread-safe single-page rasterize.
 */
class PdfLazySession {
 public:
  PdfLazySession(const PdfLazySession&) = delete;
  PdfLazySession& operator=(const PdfLazySession&) = delete;
  PdfLazySession(PdfLazySession&&) = delete;
  PdfLazySession& operator=(PdfLazySession&&) = delete;
  ~PdfLazySession();

  /**
   * Open PDF from bytes. Copies bytes into owned storage.
   * On failure returns nullptr and sets err_code / err_message.
   */
  static std::unique_ptr<PdfLazySession> Open(
      const uint8_t* pdf_bytes,
      size_t pdf_size,
      int dpi,
      int max_side,
      std::string* err_code,
      std::string* err_message);

  int page_count() const { return page_count_; }
  int dpi() const { return dpi_; }
  int max_side() const { return max_side_; }

  /**
   * Rasterize one 1-based page into packed RGB8.
   * Sets pageNumber / dpi on the frame.
   */
  bool RasterizePage(
      int page_1based,
      image::RgbFrame* out,
      std::string* err_code,
      std::string* err_message);

 private:
  PdfLazySession(
      std::vector<uint8_t> bytes,
      PdfDocument doc,
      int page_count,
      int dpi,
      int max_side);

  std::vector<uint8_t> bytes_;
  PdfDocument doc_;
  int page_count_ = 0;
  int dpi_ = 144;
  int max_side_ = 4096;
  mutable std::mutex mu_;
};

}  // namespace pdf
}  // namespace sherpa_onnx
