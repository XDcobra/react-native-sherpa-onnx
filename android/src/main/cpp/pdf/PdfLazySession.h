#pragma once

#include "PdfDocument.h"
#include "PdfLazyBackend.h"
#include "PdfTypes.h"

#include "ImageTypes.h"

#include <memory>
#include <mutex>
#include <string>

namespace sherpa_onnx {
namespace pdf {

/**
 * Retained PDFium document for lazy-lru OfflineImageBuffer slots.
 * Owns the open FPDF_DOCUMENT (and dup'd fd when opened from a PFD).
 * Thread-safe single-page rasterize.
 */
class PdfLazySession final : public PdfLazyBackend {
 public:
  PdfLazySession(const PdfLazySession&) = delete;
  PdfLazySession& operator=(const PdfLazySession&) = delete;
  PdfLazySession(PdfLazySession&&) = delete;
  PdfLazySession& operator=(PdfLazySession&&) = delete;
  ~PdfLazySession() override;

  static std::unique_ptr<PdfLazySession> Open(
      const PdfSource& src,
      int dpi,
      int max_side,
      std::string* err_code,
      std::string* err_message,
      const char* password = nullptr);

  int page_count() const override { return page_count_; }
  int dpi() const override { return dpi_; }
  int max_side() const override { return max_side_; }

  bool RasterizePage(
      int page_1based,
      image::RgbFrame* out,
      std::string* err_code,
      std::string* err_message) override;

 private:
  PdfLazySession(PdfDocument doc, int page_count, int dpi, int max_side);

  PdfDocument doc_;
  int page_count_ = 0;
  int dpi_ = 144;
  int max_side_ = 4096;
  mutable std::mutex mu_;
};

}  // namespace pdf
}  // namespace sherpa_onnx
