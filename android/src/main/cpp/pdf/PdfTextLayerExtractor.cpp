#include "PdfTextLayerExtractor.h"
#include "PdfDocument.h"
#include "PdfFeatureGuard.h"

#include <algorithm>
#include <cstring>
#include <sstream>

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
#include "fpdfview.h"
#include "fpdf_text.h"
#endif

namespace sherpa_onnx {
namespace pdf {
namespace {

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM

/** Convert PDFium bottom-left box to top-left y-down quad (tl,tr,br,bl). */
void BoxToQuadTopLeft(
    double left,
    double bottom,
    double right,
    double top,
    double page_height,
    float out_quad[8]) {
  const float y0 = static_cast<float>(page_height - top);
  const float y1 = static_cast<float>(page_height - bottom);
  const float x0 = static_cast<float>(left);
  const float x1 = static_cast<float>(right);
  out_quad[0] = x0;
  out_quad[1] = y0;
  out_quad[2] = x1;
  out_quad[3] = y0;
  out_quad[4] = x1;
  out_quad[5] = y1;
  out_quad[6] = x0;
  out_quad[7] = y1;
}

std::string WideToUtf8(const std::u16string& w) {
  std::string out;
  out.reserve(w.size() * 3);
  for (char16_t ch : w) {
    if (ch == 0) {
      continue;
    }
    if (ch < 0x80) {
      out.push_back(static_cast<char>(ch));
    } else if (ch < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (ch >> 6)));
      out.push_back(static_cast<char>(0x80 | (ch & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xE0 | (ch >> 12)));
      out.push_back(static_cast<char>(0x80 | ((ch >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (ch & 0x3F)));
    }
  }
  return out;
}

/** UTF-16 code unit length of UTF-8 string (matches JS String length for BMP). */
int Utf16LengthOfUtf8(const std::string& utf8) {
  int n = 0;
  for (size_t i = 0; i < utf8.size();) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    if (c < 0x80) {
      i += 1;
      n += 1;
    } else if ((c >> 5) == 0x6) {
      i += 2;
      n += 1;
    } else if ((c >> 4) == 0xE) {
      i += 3;
      n += 1;
    } else if ((c >> 3) == 0x1E) {
      i += 4;
      n += 2;  // surrogate pair
    } else {
      i += 1;
      n += 1;
    }
  }
  return n;
}

PdfTextLayerResult ExtractWithPdfium(
    const PdfSource& src,
    const ExtractOptions& options) {
  PdfTextLayerResult result;

  std::string open_code;
  std::string open_msg;
  PdfDocument doc = PdfDocument::Open(
      src, &open_code, &open_msg, PdfPasswordOrNull(options.password));
  if (!doc.ok()) {
    result.error_code = open_code.empty() ? kErrOpenFailed : open_code;
    result.error_message = open_msg.empty() ? "Failed to open PDF" : open_msg;
    return result;
  }

  const int page_count = doc.page_count();
  result.page_count = page_count;

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
      result.text.clear();
      result.spans.clear();
      return result;
    }
  }

  const int total = static_cast<int>(pages.size());
  int done = 0;
  if (options.on_progress) {
    options.on_progress(0, total, "extract");
  }

  std::ostringstream text_acc;
  int utf16_offset = 0;
  int pages_with_text = 0;
  FPDF_DOCUMENT raw = doc.handle();

  for (int page_1based : pages) {
    if (options.is_cancelled && options.is_cancelled()) {
      result.error_code = kErrCancelled;
      result.error_message = "cancelled";
      result.text.clear();
      result.spans.clear();
      return result;
    }

    const int page_index = page_1based - 1;
    FPDF_PAGE page = FPDF_LoadPage(raw, page_index);
    if (!page) {
      ++done;
      if (options.on_progress) {
        options.on_progress(done, total, "extract");
      }
      continue;
    }

    const double page_width = FPDF_GetPageWidth(page);
    const double page_height = FPDF_GetPageHeight(page);
    FPDF_TEXTPAGE text_page = FPDFText_LoadPage(page);
    if (!text_page) {
      FPDF_ClosePage(page);
      ++done;
      if (options.on_progress) {
        options.on_progress(done, total, "extract");
      }
      continue;
    }

    const int char_count = FPDFText_CountChars(text_page);
    bool page_has_text = false;

    if (char_count > 0) {
      const int rect_count = FPDFText_CountRects(text_page, 0, char_count);
      if (rect_count <= 0) {
        std::vector<unsigned short> buf(static_cast<size_t>(char_count) + 1, 0);
        const int got =
            FPDFText_GetText(text_page, 0, char_count, buf.data());
        if (got > 0) {
          std::u16string wide;
          wide.reserve(static_cast<size_t>(got));
          for (int i = 0; i < got; ++i) {
            if (buf[static_cast<size_t>(i)] == 0) {
              break;
            }
            wide.push_back(static_cast<char16_t>(buf[static_cast<size_t>(i)]));
          }
          const std::string piece = WideToUtf8(wide);
          if (!piece.empty()) {
            page_has_text = true;
            if (utf16_offset > 0) {
              text_acc << '\n';
              utf16_offset += 1;
            }
            const int start = utf16_offset;
            text_acc << piece;
            const int len = Utf16LengthOfUtf8(piece);
            utf16_offset += len;
            PdfTextSpan span;
            span.utf16_start = start;
            span.utf16_end = start + len;
            span.level = "block";
            span.page_number = page_1based;
            span.page_width = static_cast<float>(page_width);
            span.page_height = static_cast<float>(page_height);
            span.frame_index = page_1based - 1;
            BoxToQuadTopLeft(0, 0, page_width, page_height, page_height, span.quad);
            result.spans.push_back(span);
          }
        }
      } else {
        for (int ri = 0; ri < rect_count; ++ri) {
          double left = 0, top = 0, right = 0, bottom = 0;
          FPDFText_GetRect(text_page, ri, &left, &top, &right, &bottom);
          unsigned short bounded[4096];
          std::memset(bounded, 0, sizeof(bounded));
          const int nchars = FPDFText_GetBoundedText(
              text_page, left, top, right, bottom, bounded, 4095);
          if (nchars <= 0) {
            continue;
          }
          std::u16string wide;
          wide.reserve(static_cast<size_t>(nchars));
          for (int i = 0; i < nchars && i < 4095; ++i) {
            if (bounded[i] == 0) {
              break;
            }
            wide.push_back(static_cast<char16_t>(bounded[i]));
          }
          const std::string piece = WideToUtf8(wide);
          if (piece.empty()) {
            continue;
          }
          page_has_text = true;
          if (utf16_offset > 0) {
            text_acc << '\n';
            utf16_offset += 1;
          }
          const int start = utf16_offset;
          text_acc << piece;
          const int len = Utf16LengthOfUtf8(piece);
          utf16_offset += len;

          PdfTextSpan span;
          span.utf16_start = start;
          span.utf16_end = start + len;
          span.level = "line";
          span.page_number = page_1based;
          span.page_width = static_cast<float>(page_width);
          span.page_height = static_cast<float>(page_height);
          span.frame_index = page_1based - 1;
          BoxToQuadTopLeft(left, bottom, right, top, page_height, span.quad);
          result.spans.push_back(span);
        }
      }
    }

    if (page_has_text) {
      ++pages_with_text;
    }

    FPDFText_ClosePage(text_page);
    FPDF_ClosePage(page);
    ++done;
    if (options.on_progress) {
      options.on_progress(done, total, "extract");
    }
  }

  result.pages_with_text = pages_with_text;
  result.text = text_acc.str();

  if (pages_with_text == 0 || result.text.empty()) {
    result.error_code = kErrNoTextLayer;
    result.error_message =
        "No extractable text layer on the selected pages (scan-only PDF or empty)";
    result.text.clear();
    result.spans.clear();
    return result;
  }

  result.ok = true;
  if (options.on_progress) {
    options.on_progress(total, total, "done");
  }
  return result;
}

#else  // !HAVE_PDFIUM

PdfTextLayerResult ExtractDisabled() {
  PdfTextLayerResult result;
  result.error_code = kErrDisabled;
  result.error_message =
      "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true "
      "(Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium "
      "prebuilts resolve.";
  return result;
}

#endif

}  // namespace

PdfTextLayerResult ExtractPdfTextLayer(
    const PdfSource& src,
    const ExtractOptions& options) {
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  (void)IsPdfiumCompiledIn();
  return ExtractWithPdfium(src, options);
#else
  (void)src;
  (void)options;
  return ExtractDisabled();
#endif
}

}  // namespace pdf
}  // namespace sherpa_onnx
