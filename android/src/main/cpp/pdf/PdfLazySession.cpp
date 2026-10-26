#include "PdfLazySession.h"

#include "PdfFeatureGuard.h"
#include "PdfPageRasterizer.h"

#include <utility>

#if defined(__ANDROID__)
#include <android/log.h>
#define PDF_LAZY_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:pdf.lazy", __VA_ARGS__)
#else
#define PDF_LAZY_LOGI(...) \
  do {                     \
  } while (0)
#endif

namespace sherpa_onnx {
namespace pdf {

PdfLazySession::PdfLazySession(
    std::vector<uint8_t> bytes,
    PdfDocument doc,
    int page_count,
    int dpi,
    int max_side)
    : bytes_(std::move(bytes)),
      doc_(std::move(doc)),
      page_count_(page_count),
      dpi_(dpi),
      max_side_(max_side) {}

PdfLazySession::~PdfLazySession() {
  PDF_LAZY_LOGI("session destroy pageCount=%d", page_count_);
}

std::unique_ptr<PdfLazySession> PdfLazySession::Open(
    const uint8_t* pdf_bytes,
    size_t pdf_size,
    int dpi,
    int max_side,
    std::string* err_code,
    std::string* err_message) {
  if (dpi <= 0) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "dpi must be > 0";
    return nullptr;
  }
  if (pdf_bytes == nullptr || pdf_size == 0) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "PDF bytes required";
    return nullptr;
  }

#if !(defined(HAVE_PDFIUM) && HAVE_PDFIUM)
  (void)IsPdfiumCompiledIn();
  if (err_code) *err_code = kErrDisabled;
  if (err_message) {
    *err_message =
        "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true "
        "(Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium "
        "prebuilts resolve.";
  }
  return nullptr;
#else
  (void)IsPdfiumCompiledIn();

  std::vector<uint8_t> owned(pdf_bytes, pdf_bytes + pdf_size);
  std::string open_code;
  std::string open_msg;
  PdfDocument doc =
      PdfDocument::OpenMem(owned.data(), owned.size(), &open_code, &open_msg);
  if (!doc.ok()) {
    if (err_code) *err_code = open_code.empty() ? kErrOpenFailed : open_code;
    if (err_message) {
      *err_message = open_msg.empty() ? "Failed to open PDF" : open_msg;
    }
    return nullptr;
  }

  const int page_count = doc.page_count();
  if (page_count <= 0) {
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) *err_message = "PDF has no pages";
    return nullptr;
  }

  PDF_LAZY_LOGI(
      "session open pageCount=%d dpi=%d maxSide=%d", page_count, dpi, max_side);
  return std::unique_ptr<PdfLazySession>(new PdfLazySession(
      std::move(owned), std::move(doc), page_count, dpi, max_side));
#endif
}

bool PdfLazySession::RasterizePage(
    int page_1based,
    image::RgbFrame* out,
    std::string* err_code,
    std::string* err_message) {
  std::lock_guard<std::mutex> lock(mu_);
  const bool ok = RasterizePdfPage(
      doc_, page_1based, dpi_, max_side_, out, err_code, err_message);
  if (ok) {
    PDF_LAZY_LOGI(
        "rasterize page=%d %dx%d", page_1based,
        out ? out->width : 0, out ? out->height : 0);
  }
  return ok;
}

}  // namespace pdf
}  // namespace sherpa_onnx
