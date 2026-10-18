#pragma once

#include "PdfTypes.h"

#include <cstddef>
#include <cstdint>
#include <string>

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
#include "fpdfview.h"
#endif

namespace sherpa_onnx {
namespace pdf {

/**
 * RAII wrapper around an in-memory FPDF_DOCUMENT.
 * Only usable when HAVE_PDFIUM is defined; otherwise OpenMem fails with DISABLED.
 */
class PdfDocument {
 public:
  PdfDocument() = default;
  PdfDocument(const PdfDocument&) = delete;
  PdfDocument& operator=(const PdfDocument&) = delete;
  PdfDocument(PdfDocument&& other) noexcept;
  PdfDocument& operator=(PdfDocument&& other) noexcept;
  ~PdfDocument();

  /**
   * Load PDF from memory. On failure, sets err_code / err_message and returns
   * an invalid document (ok() == false).
   */
  static PdfDocument OpenMem(
      const uint8_t* pdf_bytes,
      size_t pdf_size,
      std::string* err_code,
      std::string* err_message);

  bool ok() const;
  int page_count() const;

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  FPDF_DOCUMENT handle() const { return doc_; }
#endif

 private:
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  explicit PdfDocument(FPDF_DOCUMENT doc) : doc_(doc) {}
  FPDF_DOCUMENT doc_ = nullptr;
#endif
};

}  // namespace pdf
}  // namespace sherpa_onnx
