#pragma once

/**
 * Reading text and structure from the text layer of a PDF (pure algorithm,
 * no PDFium; the adapter in PdfTextLayerExtractor feeds it). Lines come in
 * the PDF's content order, which keeps authored columns together.
 *
 * - Paragraphs: consecutive lines close below each other, without a
 *   first-line indent, after a line that ended where the next line's first
 *   word would not have fit (a typesetter's wrap); wrapped lines joined by a
 *   space (no space between CJK characters, hyphenated line ends rejoined).
 *   Paragraphs are separated by a blank line.
 * - Headings: lines clearly larger than the body text (by font size), short;
 *   consecutive heading lines of one size merge. Heading sizes within 15 % of
 *   each other share a level; levels 1–3 from the largest size down.
 * - Furniture: lines in the top / bottom band that repeat across pages
 *   (digits ignored) or are page numbers; kept as blocks with the furniture
 *   flag so a reader can hide them.
 * - Sections: one per page (`kind: "page"`), block 0 is the page image,
 *   then the text blocks of the page.
 * - Contents: the outline when the PDF has one, else the detected headings.
 */

#include "PdfTypes.h"

#include "../textbuffer/TxtStructure.h"

#include <memory>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace pdf {

/** One text line of a page; box in points, top-left origin (y grows down). */
struct PdfLine {
  std::string text;  // UTF-8, no line break
  float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  float font_size = 0;  // median of the line's characters, points
  /** Width of the line's first word, points; 0 = unknown (estimated from the text). */
  float first_word_width = 0;
};

struct PdfPageText {
  int page_number = 1;  // 1-based
  float width = 0;      // points
  float height = 0;
  std::string label;    // page label ("iv", "12"); empty if none
  std::vector<PdfLine> lines;
};

struct PdfOutlineEntry {
  std::string title;
  int level = 1;        // nesting depth from 1
  int page_number = 0;  // 1-based; 0 = no destination
};

struct PdfDocInfo {
  std::string title;
  std::string author;
  std::string language;
  std::vector<PdfOutlineEntry> outline;
};

struct PdfReadingText {
  std::string text;
  /** One `line` span per line (quads in points, top-left), ranges into `text`. */
  std::vector<PdfTextSpan> spans;
  std::shared_ptr<TxtStructure> structure;
  int pages_with_text = 0;
};

/** Structure rules version for format "pdf" (see SupportedStructureVersion). */
inline constexpr int kPdfStructureVersion = 1;

PdfReadingText BuildPdfReadingText(const std::vector<PdfPageText>& pages,
                                   const PdfDocInfo& info);

}  // namespace pdf
}  // namespace sherpa_onnx
