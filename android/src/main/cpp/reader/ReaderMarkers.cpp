#include "ReaderMarkers.h"

#include "../textbuffer/TxtUtf16.h"

#include <algorithm>

namespace sherpa_onnx {
namespace reader {

namespace {

bool IsTextBlock(const ReaderBlock& b) {
  return b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading;
}

/** Start of the code point holding UTF-16 unit `offset` (moves off a low surrogate). */
int CodePointStart(const std::string& utf8, int offset) {
  const auto* p = reinterpret_cast<const unsigned char*>(utf8.data());
  const auto* end = p + utf8.size();
  int units = 0;
  while (p < end) {
    size_t adv = 0;
    int u = 0;
    txt_utf16_advance(p, end, &adv, &u);
    if (adv == 0) break;
    if (units + u > offset) return units;
    units += u;
    p += adv;
  }
  return units;
}

}  // namespace

ResolvedMarkers ResolveMarkers(const ReaderSnapshot& snap, const std::vector<MarkerInput>& inputs) {
  ResolvedMarkers out;
  for (size_t i = 0; i < inputs.size(); ++i) {
    const MarkerInput& m = inputs[i];
    const int block = snap.BlockIndex(m.blockId);
    if (block < 0 || (m.start >= 0 && m.end >= 0 && m.end < m.start)) {
      out.invalidIds.push_back(m.id);
      continue;
    }
    MarkerAnchor a;
    a.input = static_cast<int>(i);
    const int len = snap.BlockLength(block);
    if (IsTextBlock(snap.blocks[block]) && len > 0 && (m.start >= 0 || m.end >= 0)) {
      // The range's last character; an empty range or `start` alone: its first.
      int at = m.end > 0 && m.end > m.start ? m.end - 1 : std::max(0, m.start);
      at = std::max(0, std::min(at, len - 1));
      a.offset = CodePointStart(snap.BlockText(block), at);
    }
    out.byBlock[block].push_back(a);
  }
  return out;
}

PageRect MarkerPageRect(const ReaderSnapshot& snap, int block, int offset) {
  if (block < 0 || block >= static_cast<int>(snap.blocks.size())) return {0, 0, 1, 0};
  const ReaderBlock& b = snap.blocks[block];
  if (offset >= 0) {
    for (const ReaderLineBox& l : b.lines) {
      if (offset >= l.start && offset < l.end) return {l.rect[0], l.rect[1], l.rect[2], l.rect[3]};
    }
  }
  if (!b.lines.empty()) {
    const ReaderLineBox& l = b.lines.front();
    return {l.rect[0], l.rect[1], l.rect[2], l.rect[3]};
  }
  if (b.hasRect) return {b.rect[0], b.rect[1], b.rect[2], b.rect[3]};
  return {0, 0, 1, 0};
}

}  // namespace reader
}  // namespace sherpa_onnx
