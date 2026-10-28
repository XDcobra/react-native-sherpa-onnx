#include "PdfPageRasterizer.h"
#include "PdfDocument.h"
#include "PdfFeatureGuard.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
#include "fpdfview.h"
#endif

namespace sherpa_onnx {
namespace pdf {
namespace {

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM

void BgraToRgb(
    const uint8_t* bgra,
    int width,
    int height,
    int stride,
    std::vector<uint8_t>* out_rgb) {
  out_rgb->resize(static_cast<size_t>(width) * static_cast<size_t>(height) * 3u);
  for (int y = 0; y < height; ++y) {
    const uint8_t* row = bgra + static_cast<size_t>(y) * static_cast<size_t>(stride);
    uint8_t* dst =
        out_rgb->data() + static_cast<size_t>(y) * static_cast<size_t>(width) * 3u;
    for (int x = 0; x < width; ++x) {
      const uint8_t* px = row + static_cast<size_t>(x) * 4u;
      dst[0] = px[2];  // R
      dst[1] = px[1];  // G
      dst[2] = px[0];  // B
      dst += 3;
    }
  }
}

void ComputePixelSize(
    double page_width_pt,
    double page_height_pt,
    int dpi,
    int max_side,
    int* out_w,
    int* out_h) {
  const double scale = static_cast<double>(dpi) / 72.0;
  int w = std::max(1, static_cast<int>(std::lround(page_width_pt * scale)));
  int h = std::max(1, static_cast<int>(std::lround(page_height_pt * scale)));
  if (max_side > 0) {
    const int longest = std::max(w, h);
    if (longest > max_side) {
      const double s = static_cast<double>(max_side) / static_cast<double>(longest);
      w = std::max(1, static_cast<int>(std::lround(w * s)));
      h = std::max(1, static_cast<int>(std::lround(h * s)));
    }
  }
  *out_w = w;
  *out_h = h;
}

bool RasterizePageUnlocked(
    FPDF_DOCUMENT raw,
    int page_1based,
    int page_count,
    int dpi,
    int max_side,
    image::RgbFrame* out,
    std::string* err_code,
    std::string* err_message) {
  if (!out) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "out frame required";
    return false;
  }
  if (dpi <= 0) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "dpi must be > 0";
    return false;
  }
  if (!raw || page_1based < 1 || page_1based > page_count) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "page index out of range (1-based)";
    return false;
  }

  const int page_index = page_1based - 1;
  FPDF_PAGE page = FPDF_LoadPage(raw, page_index);
  if (!page) {
    if (err_code) *err_code = kErrRenderFailed;
    if (err_message) *err_message = "FPDF_LoadPage failed";
    return false;
  }

  const double page_width = FPDF_GetPageWidth(page);
  const double page_height = FPDF_GetPageHeight(page);
  int bw = 0;
  int bh = 0;
  ComputePixelSize(page_width, page_height, dpi, max_side, &bw, &bh);

  FPDF_BITMAP bitmap = FPDFBitmap_Create(bw, bh, 1 /* alpha */);
  if (!bitmap) {
    FPDF_ClosePage(page);
    if (err_code) *err_code = kErrRenderFailed;
    if (err_message) *err_message = "FPDFBitmap_Create failed";
    return false;
  }

  // Opaque white background (BGRA).
  FPDFBitmap_FillRect(bitmap, 0, 0, bw, bh, 0xFFFFFFFF);
  FPDF_RenderPageBitmap(bitmap, page, 0, 0, bw, bh, 0, FPDF_ANNOT);

  void* buffer = FPDFBitmap_GetBuffer(bitmap);
  const int stride = FPDFBitmap_GetStride(bitmap);
  if (!buffer || stride <= 0) {
    FPDFBitmap_Destroy(bitmap);
    FPDF_ClosePage(page);
    if (err_code) *err_code = kErrRenderFailed;
    if (err_message) *err_message = "FPDFBitmap buffer unavailable";
    return false;
  }

  image::RgbFrame frame;
  frame.width = bw;
  frame.height = bh;
  frame.pageNumber = page_1based;
  frame.dpi = dpi;
  BgraToRgb(static_cast<const uint8_t*>(buffer), bw, bh, stride, &frame.rgb);

  FPDFBitmap_Destroy(bitmap);
  FPDF_ClosePage(page);

  if (!frame.valid()) {
    if (err_code) *err_code = kErrRenderFailed;
    if (err_message) *err_message = "invalid RGB frame after raster";
    return false;
  }

  *out = std::move(frame);
  return true;
}

PdfRasterResult RasterizeWithPdfium(
    const PdfSource& src,
    const RasterOptions& options) {
  PdfRasterResult result;

  if (options.dpi <= 0) {
    result.error_code = kErrInvalidArgument;
    result.error_message = "dpi must be > 0";
    return result;
  }

  std::string open_code;
  std::string open_msg;
  PdfDocument doc = PdfDocument::Open(src, &open_code, &open_msg);
  if (!doc.ok()) {
    result.error_code = open_code.empty() ? kErrOpenFailed : open_code;
    result.error_message = open_msg.empty() ? "Failed to open PDF" : open_msg;
    return result;
  }

  const int page_count = doc.page_count();
  result.page_count = page_count;
  if (page_count <= 0) {
    result.error_code = kErrOpenFailed;
    result.error_message = "PDF has no pages";
    return result;
  }

  std::vector<int> pages = options.pages;
  if (pages.empty()) {
    pages.reserve(static_cast<size_t>(page_count));
    for (int p = 1; p <= page_count; ++p) {
      pages.push_back(p);
    }
  }

  for (int page_1based : pages) {
    if (page_1based < 1 || page_1based > page_count) {
      result.error_code = kErrInvalidArgument;
      result.error_message = "page index out of range (1-based)";
      return result;
    }
  }

  const int total = static_cast<int>(pages.size());
  if (total == 0) {
    result.error_code = kErrInvalidArgument;
    result.error_message = "no pages to rasterize";
    return result;
  }

  int done = 0;
  if (options.on_progress) {
    options.on_progress(0, total, "raster");
  }

  result.frames.reserve(static_cast<size_t>(total));

  for (int page_1based : pages) {
    if (options.is_cancelled && options.is_cancelled()) {
      result.error_code = kErrCancelled;
      result.error_message = "cancelled";
      result.frames.clear();
      return result;
    }

    image::RgbFrame frame;
    std::string err_code;
    std::string err_msg;
    if (!RasterizePageUnlocked(
            doc.handle(), page_1based, page_count, options.dpi, options.max_side,
            &frame, &err_code, &err_msg)) {
      result.error_code = err_code.empty() ? kErrRenderFailed : err_code;
      result.error_message = err_msg.empty() ? "render failed" : err_msg;
      result.frames.clear();
      return result;
    }

    result.frames.push_back(std::move(frame));
    ++done;
    if (options.on_progress) {
      options.on_progress(done, total, "raster");
    }
  }

  result.ok = true;
  if (options.on_progress) {
    options.on_progress(total, total, "done");
  }
  return result;
}

#else  // !HAVE_PDFIUM

PdfRasterResult RasterizeDisabled() {
  PdfRasterResult result;
  result.error_code = kErrDisabled;
  result.error_message =
      "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true "
      "(Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium "
      "prebuilts resolve.";
  return result;
}

#endif

}  // namespace

bool RasterizePdfPage(
    const PdfDocument& doc,
    int page_1based,
    int dpi,
    int max_side,
    image::RgbFrame* out,
    std::string* err_code,
    std::string* err_message) {
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  if (!doc.ok()) {
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) *err_message = "PDF document not open";
    return false;
  }
  return RasterizePageUnlocked(
      doc.handle(), page_1based, doc.page_count(), dpi, max_side, out, err_code,
      err_message);
#else
  (void)doc;
  (void)page_1based;
  (void)dpi;
  (void)max_side;
  (void)out;
  if (err_code) *err_code = kErrDisabled;
  if (err_message) {
    *err_message =
        "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true "
        "(Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium "
        "prebuilts resolve.";
  }
  return false;
#endif
}

PdfRasterResult RasterizePdfPages(
    const PdfSource& src,
    const RasterOptions& options) {
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  (void)IsPdfiumCompiledIn();
  return RasterizeWithPdfium(src, options);
#else
  (void)src;
  (void)options;
  return RasterizeDisabled();
#endif
}

}  // namespace pdf
}  // namespace sherpa_onnx
