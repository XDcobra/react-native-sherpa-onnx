#include "ReaderLayout.h"

#include <algorithm>
#include <cstring>

namespace sherpa_onnx {
namespace reader {

namespace {

bool IsText(const ReaderBlock& b) {
  return b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading;
}

bool IsFurniture(const ReaderBlock& b) { return (b.flags & kBlockFurniture) != 0; }

/** Section [first, end) whose first block is its page image. */
bool IsPageSection(const ReaderSnapshot& snap, const ReaderSection& sec) {
  return sec.blockCount > 0 && snap.blocks[sec.firstBlock].type == ReaderBlockType::Page;
}

bool Counts(float shown, float height, float viewport) {
  return height > 0 && shown >= 0.5f * std::min(height, viewport);
}

}  // namespace

PageDisplay PageDisplayFromName(const char* name) {
  if (name && std::strcmp(name, "image") == 0) return PageDisplay::kImage;
  if (name && std::strcmp(name, "imageAndText") == 0) return PageDisplay::kImageAndText;
  return PageDisplay::kText;
}

std::vector<ReaderRow> PlanRows(const ReaderSnapshot& snap, PageDisplay mode) {
  std::vector<ReaderRow> rows;
  rows.reserve(snap.blocks.size());
  for (const ReaderSection& sec : snap.sections) {
    const int first = sec.firstBlock;
    const int end = sec.firstBlock + sec.blockCount;
    if (!IsPageSection(snap, sec)) {
      for (int i = first; i < end; ++i) rows.push_back({i, i, i, false});
      continue;
    }
    if (mode == PageDisplay::kImage) {
      rows.push_back({first, first, end - 1, true});
      continue;
    }
    // Which blocks get a row of their own.
    bool hasText = false;
    for (int i = first + 1; i < end; ++i) {
      const ReaderBlock& b = snap.blocks[i];
      if (IsText(b) && !IsFurniture(b) && snap.BlockLength(i) > 0) hasText = true;
    }
    std::vector<bool> shown(static_cast<size_t>(end - first), false);
    shown[0] = mode == PageDisplay::kImageAndText || !hasText;
    for (int i = first + 1; i < end; ++i) {
      const ReaderBlock& b = snap.blocks[i];
      shown[static_cast<size_t>(i - first)] = !IsFurniture(b) && (!IsText(b) || snap.BlockLength(i) > 0);
    }
    // Hidden blocks join the previous row of the section; leading ones the first.
    const size_t sectionRows = rows.size();
    int pendingFrom = -1;
    for (int i = first; i < end; ++i) {
      if (!shown[static_cast<size_t>(i - first)]) {
        if (rows.size() > sectionRows) {
          rows.back().coverLast = i;
        } else if (pendingFrom < 0) {
          pendingFrom = i;
        }
        continue;
      }
      ReaderRow r{i, pendingFrom >= 0 ? pendingFrom : i, i, i == first};
      pendingFrom = -1;
      rows.push_back(r);
    }
    if (rows.size() == sectionRows) {
      // Nothing shown (cannot happen: a page without text shows its image).
      rows.push_back({first, first, end - 1, true});
    }
  }
  return rows;
}

bool RowVisibleBlocks(const ReaderSnapshot& snap, const ReaderRow& row, float visibleTop,
                      float visibleBottom, float rowHeight, float viewport, int* first,
                      int* last) {
  const float rowShown = std::max(0.f, std::min(visibleBottom, rowHeight) - std::max(visibleTop, 0.f));
  const bool rowCounts = Counts(rowShown, rowHeight, viewport);
  const bool byRect = row.page && row.coverLast > row.block;
  if (!byRect) {
    if (!rowCounts) return false;
    *first = row.coverFirst;
    *last = row.coverLast;
    return true;
  }
  if (rowShown <= 0) return false;
  int lo = -1;
  int hi = -1;
  auto add = [&](int i) {
    if (lo < 0 || i < lo) lo = i;
    if (i > hi) hi = i;
  };
  for (int i = row.coverFirst; i <= row.coverLast; ++i) {
    if (i == row.block) continue;
    const ReaderBlock& b = snap.blocks[i];
    if (!b.hasRect) {
      if (rowCounts) add(i);
      continue;
    }
    const float top = b.rect[1] * rowHeight;
    const float height = std::max(1.f, b.rect[3] * rowHeight);
    const float shown = std::min(visibleBottom, top + height) - std::max(visibleTop, top);
    if (Counts(shown, height, viewport)) add(i);
  }
  // The page itself: while its top edge is on screen, or as the fallback.
  const bool topOnScreen = visibleTop <= 0.5f && visibleBottom > 0;
  if ((topOnScreen && rowCounts) || (lo < 0 && rowCounts)) add(row.block);
  if (lo < 0) return false;
  *first = lo;
  *last = hi;
  return true;
}

int RowOfBlock(const std::vector<ReaderRow>& rows, int block) {
  // Rows are in block order and their cover ranges do not overlap.
  auto it = std::lower_bound(rows.begin(), rows.end(), block,
                             [](const ReaderRow& r, int b) { return r.coverLast < b; });
  if (it == rows.end() || it->coverFirst > block) return -1;
  return static_cast<int>(it - rows.begin());
}

float BlockOffsetInRow(const ReaderSnapshot& snap, const ReaderRow& row, int block,
                       float rowHeight) {
  if (!row.page || block == row.block || block < 0 ||
      block >= static_cast<int>(snap.blocks.size())) {
    return 0;
  }
  const ReaderBlock& b = snap.blocks[block];
  return b.hasRect ? std::max(0.f, b.rect[1] * rowHeight) : 0;
}

}  // namespace reader
}  // namespace sherpa_onnx
