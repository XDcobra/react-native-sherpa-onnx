#include "PdfDocument.h"

#include <mutex>
#include <utility>

namespace sherpa_onnx {
namespace pdf {

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM

namespace {

std::once_flag g_pdfium_once;

void EnsurePdfiumInit() {
  std::call_once(g_pdfium_once, []() { FPDF_InitLibrary(); });
}

}  // namespace

PdfDocument::PdfDocument(PdfDocument&& other) noexcept : doc_(other.doc_) {
  other.doc_ = nullptr;
}

PdfDocument& PdfDocument::operator=(PdfDocument&& other) noexcept {
  if (this != &other) {
    if (doc_) {
      FPDF_CloseDocument(doc_);
    }
    doc_ = other.doc_;
    other.doc_ = nullptr;
  }
  return *this;
}

PdfDocument::~PdfDocument() {
  if (doc_) {
    FPDF_CloseDocument(doc_);
    doc_ = nullptr;
  }
}

bool PdfDocument::ok() const { return doc_ != nullptr; }

int PdfDocument::page_count() const {
  return doc_ ? FPDF_GetPageCount(doc_) : 0;
}

PdfDocument PdfDocument::OpenMem(
    const uint8_t* pdf_bytes,
    size_t pdf_size,
    std::string* err_code,
    std::string* err_message) {
  if (pdf_bytes == nullptr || pdf_size == 0) {
    if (err_code) {
      *err_code = kErrInvalidArgument;
    }
    if (err_message) {
      *err_message = "PDF bytes required";
    }
    return PdfDocument();
  }

  EnsurePdfiumInit();
  FPDF_DOCUMENT doc =
      FPDF_LoadMemDocument(pdf_bytes, static_cast<int>(pdf_size), nullptr);
  if (!doc) {
    const unsigned long err = FPDF_GetLastError();
    if (err == FPDF_ERR_PASSWORD) {
      if (err_code) {
        *err_code = kErrEncrypted;
      }
      if (err_message) {
        *err_message = "PDF is encrypted or password-protected";
      }
    } else {
      if (err_code) {
        *err_code = kErrOpenFailed;
      }
      if (err_message) {
        *err_message = "Failed to open PDF document";
      }
    }
    return PdfDocument();
  }
  return PdfDocument(doc);
}

#else  // !HAVE_PDFIUM

PdfDocument::PdfDocument(PdfDocument&&) noexcept = default;
PdfDocument& PdfDocument::operator=(PdfDocument&&) noexcept = default;
PdfDocument::~PdfDocument() = default;

bool PdfDocument::ok() const { return false; }

int PdfDocument::page_count() const { return 0; }

PdfDocument PdfDocument::OpenMem(
    const uint8_t*,
    size_t,
    std::string* err_code,
    std::string* err_message) {
  if (err_code) {
    *err_code = kErrDisabled;
  }
  if (err_message) {
    *err_message =
        "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true "
        "(Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium "
        "prebuilts resolve.";
  }
  return PdfDocument();
}

#endif

}  // namespace pdf
}  // namespace sherpa_onnx
