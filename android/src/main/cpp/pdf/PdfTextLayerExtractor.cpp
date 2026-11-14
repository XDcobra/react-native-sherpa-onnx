#include "PdfTextLayerExtractor.h"
#include "PdfDocument.h"
#include "PdfFeatureGuard.h"
#include "PdfStructureBuilder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <set>
#include <sstream>

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
#include "fpdfview.h"
#include "fpdf_catalog.h"
#include "fpdf_doc.h"
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

void AppendUtf8(std::string* out, uint32_t cp) {
  if (cp < 0x80) {
    out->push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

/** UTF-16 → UTF-8; surrogate pairs combined, NULs dropped. */
std::string Utf16ToUtf8(const unsigned short* w, size_t n) {
  std::string out;
  out.reserve(n * 3);
  for (size_t i = 0; i < n; ++i) {
    uint32_t cp = w[i];
    if (cp == 0) continue;
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n && w[i + 1] >= 0xDC00 && w[i + 1] <= 0xDFFF) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (w[i + 1] - 0xDC00);
      ++i;
    }
    AppendUtf8(&out, cp);
  }
  return out;
}

std::string WideToUtf8(const std::u16string& w) {
  return Utf16ToUtf8(reinterpret_cast<const unsigned short*>(w.data()), w.size());
}

std::string TrimSpaces(const std::string& s) {
  size_t a = 0;
  while (a < s.size() && (s[a] == ' ' || s[a] == '\t')) ++a;
  size_t b = s.size();
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t')) --b;
  return s.substr(a, b - a);
}

/** Reads a UTF-16LE string from a PDFium getter that reports its size in bytes. */
template <typename Getter>
std::string ReadUtf16(Getter get) {
  const unsigned long bytes = get(nullptr, 0);
  if (bytes <= 2) return {};
  std::vector<unsigned short> buf(bytes / 2 + 1, 0);
  get(buf.data(), static_cast<unsigned long>(buf.size() * 2));
  return TrimSpaces(Utf16ToUtf8(buf.data(), bytes / 2));
}

/**
 * Text lines of a page from PDFium's characters: a line ends at PDFium's
 * generated line break, when the next character sits on another row, or after
 * a horizontal gap of more than three line heights (table cells, columns set
 * side by side in the content). Boxes are the characters' loose boxes (font
 * ascent to descent), top-left origin.
 */
std::vector<PdfLine> ReadPageLines(FPDF_TEXTPAGE tp, double page_height) {
  std::vector<PdfLine> lines;
  const int n = FPDFText_CountChars(tp);
  PdfLine cur;
  bool has_box = false;
  bool first_word_done = false;
  float last_x1 = 0;
  std::vector<float> sizes;
  auto flush = [&]() {
    cur.text = TrimSpaces(cur.text);
    if (has_box && !cur.text.empty()) {
      if (!first_word_done) cur.first_word_width = cur.x1 - cur.x0;
      if (!sizes.empty()) {
        std::nth_element(sizes.begin(), sizes.begin() + sizes.size() / 2, sizes.end());
        cur.font_size = sizes[sizes.size() / 2];
      }
      lines.push_back(std::move(cur));
    }
    cur = PdfLine();
    has_box = false;
    first_word_done = false;
    sizes.clear();
  };
  for (int i = 0; i < n; ++i) {
    uint32_t cp = FPDFText_GetUnicode(tp, i);
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n) {
      const uint32_t lo = FPDFText_GetUnicode(tp, i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        ++i;
      }
    }
    if (cp == '\r' || cp == '\n') {
      flush();
      continue;
    }
    if (cp == 0) continue;
    if (cp == 0x02 || cp == 0xFFFE) cp = '-';  // PDFium's mark for a hyphen at the line end
    const bool space = cp == ' ' || cp == '\t' || cp == 0xA0;
    FS_RECTF r;
    if (!space && FPDFText_IsGenerated(tp, i) != 1 && FPDFText_GetLooseCharBox(tp, i, &r)) {
      const float x0 = std::min(r.left, r.right);
      const float x1 = std::max(r.left, r.right);
      const float y0 = static_cast<float>(page_height) - std::max(r.top, r.bottom);
      const float y1 = static_cast<float>(page_height) - std::min(r.top, r.bottom);
      if (has_box) {
        const float h = std::max(1.f, cur.y1 - cur.y0);
        const float cy = 0.5f * (y0 + y1);
        if (cy < cur.y0 || cy > cur.y1 || x0 - last_x1 > 3 * h || x1 < cur.x0 - h) flush();
      }
      if (!has_box) {
        cur.x0 = x0;
        cur.y0 = y0;
        cur.x1 = x1;
        cur.y1 = y1;
        has_box = true;
      } else {
        cur.x0 = std::min(cur.x0, x0);
        cur.y0 = std::min(cur.y0, y0);
        cur.x1 = std::max(cur.x1, x1);
        cur.y1 = std::max(cur.y1, y1);
      }
      last_x1 = x1;
      // Em size scaled by the text and page matrices (PDFium reports the
      // unscaled size); the loose box height is the fallback.
      double size = FPDFText_GetFontSize(tp, i);
      FS_MATRIX m;
      if (size > 0 && FPDFText_GetMatrix(tp, i, &m)) {
        const double det = std::fabs(static_cast<double>(m.a) * m.d - static_cast<double>(m.b) * m.c);
        if (det > 1e-9) size *= std::sqrt(det);
      }
      const double box_h = y1 - y0;
      if (size <= 0 || (box_h > 0 && (box_h / size > 3.0 || box_h / size < 0.3))) {
        size = box_h / 1.15;
      }
      if (size > 0) sizes.push_back(static_cast<float>(size));
    }
    if (space) {
      if (has_box && !first_word_done) {
        cur.first_word_width = last_x1 - cur.x0;
        first_word_done = true;
      }
      if (!cur.text.empty() && cur.text.back() != ' ') cur.text.push_back(' ');
      continue;
    }
    AppendUtf8(&cur.text, cp);
  }
  flush();
  return lines;
}

void ReadOutline(FPDF_DOCUMENT doc, FPDF_BOOKMARK parent, int level,
                 std::vector<PdfOutlineEntry>* out, std::set<FPDF_BOOKMARK>* seen) {
  if (level > 16) return;
  for (FPDF_BOOKMARK b = FPDFBookmark_GetFirstChild(doc, parent); b != nullptr;
       b = FPDFBookmark_GetNextSibling(doc, b)) {
    // Malformed outlines can loop.
    if (!seen->insert(b).second || out->size() >= 10000) return;
    PdfOutlineEntry e;
    e.level = level;
    e.title = ReadUtf16(
        [&](void* buf, unsigned long len) { return FPDFBookmark_GetTitle(b, buf, len); });
    FPDF_DEST dest = FPDFBookmark_GetDest(doc, b);
    if (dest == nullptr) {
      FPDF_ACTION action = FPDFBookmark_GetAction(b);
      if (action != nullptr && FPDFAction_GetType(action) == PDFACTION_GOTO) {
        dest = FPDFAction_GetDest(doc, action);
      }
    }
    if (dest != nullptr) {
      const int idx = FPDFDest_GetDestPageIndex(doc, dest);
      if (idx >= 0) e.page_number = idx + 1;
    }
    if (!e.title.empty()) out->push_back(std::move(e));
    ReadOutline(doc, b, level + 1, out, seen);
  }
}

PdfDocInfo ReadDocInfo(FPDF_DOCUMENT doc) {
  PdfDocInfo info;
  info.title = ReadUtf16(
      [&](void* buf, unsigned long len) { return FPDF_GetMetaText(doc, "Title", buf, len); });
  info.author = ReadUtf16(
      [&](void* buf, unsigned long len) { return FPDF_GetMetaText(doc, "Author", buf, len); });
  info.language = ReadUtf16([&](void* buf, unsigned long len) {
    return FPDFCatalog_GetLanguage(doc, static_cast<FPDF_WCHAR*>(buf), len);
  });
  std::set<FPDF_BOOKMARK> seen;
  ReadOutline(doc, nullptr, 1, &info.outline, &seen);
  return info;
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
  const bool paragraphs = options.layout == PdfTextLayout::kParagraphs;
  std::vector<PdfPageText> page_texts;

  for (int page_1based : pages) {
    if (options.is_cancelled && options.is_cancelled()) {
      result.error_code = kErrCancelled;
      result.error_message = "cancelled";
      result.text.clear();
      result.spans.clear();
      return result;
    }

    const int page_index = page_1based - 1;
    // Per page, so a long extraction does not block the rasterizer.
    std::lock_guard<std::recursive_mutex> page_lock(PdfiumMutex());
    FPDF_PAGE page = FPDF_LoadPage(raw, page_index);
    if (paragraphs) {
      // Every page becomes a section, also one without text or that fails to load.
      PdfPageText pt;
      pt.page_number = page_1based;
      pt.label = ReadUtf16([&](void* buf, unsigned long len) {
        return FPDF_GetPageLabel(raw, page_index, buf, len);
      });
      if (page) {
        pt.width = static_cast<float>(FPDF_GetPageWidth(page));
        pt.height = static_cast<float>(FPDF_GetPageHeight(page));
        if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(page)) {
          pt.lines = ReadPageLines(tp, pt.height);
          FPDFText_ClosePage(tp);
        }
        FPDF_ClosePage(page);
      } else {
        FS_SIZEF size;
        if (FPDF_GetPageSizeByIndexF(raw, page_index, &size)) {
          pt.width = size.width;
          pt.height = size.height;
        }
      }
      page_texts.push_back(std::move(pt));
      ++done;
      if (options.on_progress) {
        options.on_progress(done, total, "extract");
      }
      continue;
    }
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

  if (paragraphs) {
    PdfDocInfo info;
    {
      std::lock_guard<std::recursive_mutex> lock(PdfiumMutex());
      info = ReadDocInfo(raw);
    }
    PdfReadingText reading = BuildPdfReadingText(page_texts, info);
    result.text = std::move(reading.text);
    result.spans = std::move(reading.spans);
    result.pages_with_text = reading.pages_with_text;
    result.structure = std::move(reading.structure);
    result.ok = true;
    if (options.on_progress) {
      options.on_progress(total, total, "done");
    }
    return result;
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
