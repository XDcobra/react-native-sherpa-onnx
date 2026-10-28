#pragma once

#include "PdfTypes.h"

#include <memory>
#include <string>

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
#include "fpdfview.h"
#endif

namespace sherpa_onnx {
namespace pdf {

/**
 * RAII wrapper around FPDF_DOCUMENT.
 * Path → FPDF_LoadDocument. Fd → dup + FPDF_LoadCustomDocument (pread).
 * When PDFium is not compiled in, Open* fail with ERR_PDF_PDFIUM_DISABLED.
 */
class PdfDocument {
 public:
  PdfDocument() = default;
  PdfDocument(const PdfDocument&) = delete;
  PdfDocument& operator=(const PdfDocument&) = delete;
  PdfDocument(PdfDocument&& other) noexcept;
  PdfDocument& operator=(PdfDocument&& other) noexcept;
  ~PdfDocument();

  static PdfDocument Open(
      const PdfSource& src,
      std::string* err_code,
      std::string* err_message);
  static PdfDocument OpenPath(
      const char* path,
      std::string* err_code,
      std::string* err_message);
  /** Dup `fd`; never closes the caller's descriptor. */
  static PdfDocument OpenFd(
      int fd,
      std::string* err_code,
      std::string* err_message);

  bool ok() const;
  int page_count() const;

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  FPDF_DOCUMENT handle() const { return doc_; }
#endif

 private:
  struct FileAccess;

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  PdfDocument(FPDF_DOCUMENT doc, std::unique_ptr<FileAccess> file_access);
  FPDF_DOCUMENT doc_ = nullptr;
#endif
  std::unique_ptr<FileAccess> file_access_;
};

}  // namespace pdf
}  // namespace sherpa_onnx
