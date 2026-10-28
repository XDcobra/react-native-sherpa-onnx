#include "PdfLazySession.h"

#include "PdfFeatureGuard.h"
#include "PdfLog.h"
#include "PdfPageRasterizer.h"

#include <utility>

namespace sherpa_onnx {
namespace pdf {

PdfLazySession::PdfLazySession(
    PdfDocument doc,
    int page_count,
    int dpi,
    int max_side)
    : doc_(std::move(doc)),
      page_count_(page_count),
      dpi_(dpi),
      max_side_(max_side) {}

PdfLazySession::~PdfLazySession() {
  PDF_LOGI("lazy session destroy pageCount=%d", page_count_);
}

std::unique_ptr<PdfLazySession> PdfLazySession::Open(
    const PdfSource& src,
    int dpi,
    int max_side,
    std::string* err_code,
    std::string* err_message,
    const char* password) {
  if (dpi <= 0) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "dpi must be > 0";
    return nullptr;
  }

#if !(defined(HAVE_PDFIUM) && HAVE_PDFIUM)
  (void)src;
  (void)password;
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

  std::string open_code;
  std::string open_msg;
  PdfDocument doc = PdfDocument::Open(
      src, &open_code, &open_msg, PdfPasswordOrNull(password));
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

  PDF_LOGI(
      "lazy session open pageCount=%d dpi=%d maxSide=%d path=%s fd=%d hasPassword=%d",
      page_count, dpi, max_side, src.path.c_str(), src.fd,
      PdfPasswordOrNull(password) ? 1 : 0);
  return std::unique_ptr<PdfLazySession>(
      new PdfLazySession(std::move(doc), page_count, dpi, max_side));
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
    PDF_LOGI(
        "lazy rasterize page=%d %dx%d", page_1based,
        out ? out->width : 0, out ? out->height : 0);
  }
  return ok;
}

}  // namespace pdf
}  // namespace sherpa_onnx
