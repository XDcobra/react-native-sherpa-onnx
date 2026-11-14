#pragma once

#include "ReaderDocument.h"

#include <vector>

namespace sherpa_onnx {
namespace reader {

/** How page sections (PDF pages, comic and scan pages) are shown. */
enum class PageDisplay : int {
  /** Text of the page; the page image only when the page has no text. */
  kText = 0,
  /** One full-width page image per page; it stands for the page's text. */
  kImage = 1,
  /** The page image, then the page's text. */
  kImageAndText = 2,
};

PageDisplay PageDisplayFromName(const char* name);

/**
 * One row of the ReaderView. A row shows `block` and stands for the blocks
 * [coverFirst, coverLast]: blocks without a row of their own (running headers
 * and page numbers, the page image of a page with text in kText, the page's
 * text in kImage) are attached to a row, so visibility, the furthest position
 * and section ends see every block. Rows keep block order.
 */
struct ReaderRow {
  int block = 0;
  int coverFirst = 0;
  int coverLast = 0;
  /** A page image shown full width (no margins, height from the page size). */
  bool page = false;
};

/**
 * Rows for a display mode. Sections that are not page sections (no page block
 * first) get one row per block, as always.
 */
std::vector<ReaderRow> PlanRows(const ReaderSnapshot& snap, PageDisplay mode);

/**
 * Blocks of one row that count as visible, from the part of the row on screen
 * ([visibleTop, visibleBottom] in px from the row's top), its height and the
 * viewport height. A block counts when at least half of min(its height, the
 * viewport) is on screen. On a page image that stands for its text, text
 * blocks use their rectangle on the page; the page block counts while the
 * page's top is on screen or when no text block counts. Blocks without a
 * rectangle count with the row. False when nothing counts.
 */
bool RowVisibleBlocks(const ReaderSnapshot& snap, const ReaderRow& row, float visibleTop,
                      float visibleBottom, float rowHeight, float viewport, int* first,
                      int* last);

/** Index of the row that stands for `block` (shows or covers it), -1 if none. */
int RowOfBlock(const std::vector<ReaderRow>& rows, int block);

/**
 * Offset in px from the row's top where `block` starts: its rectangle on a
 * page image, else 0. Used for scrollTo and follow on page images.
 */
float BlockOffsetInRow(const ReaderSnapshot& snap, const ReaderRow& row, int block,
                       float rowHeight);

}  // namespace reader
}  // namespace sherpa_onnx
