#include "ReaderHighlights.h"

#include "../textbuffer/TxtUtf16.h"

#include <algorithm>

namespace sherpa_onnx {
namespace reader {

namespace {

bool IsTextBlock(const ReaderBlock& b) {
  return b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading;
}

/** True when UTF-16 unit `offset` of `utf8` is a low surrogate (middle of a pair). */
bool SplitsSurrogate(const std::string& utf8, int offset) {
  if (offset <= 0) return false;
  const auto* p = reinterpret_cast<const unsigned char*>(utf8.data());
  const auto* end = p + utf8.size();
  int units = 0;
  while (p < end) {
    size_t adv = 0;
    int u = 0;
    txt_utf16_advance(p, end, &adv, &u);
    if (adv == 0) break;
    if (units + u > offset) return units < offset;  // offset falls inside this code point
    units += u;
    p += adv;
  }
  return false;
}

/** Clamps `offset` into [0, len] and moves it back off a surrogate middle. */
int SafeOffset(const ReaderSnapshot& snap, int block, int offset) {
  const int len = snap.BlockLength(block);
  offset = std::max(0, std::min(offset, len));
  if (offset > 0 && offset < len && SplitsSurrogate(snap.BlockText(block), offset)) --offset;
  return offset;
}

}  // namespace

ResolvedHighlights ResolveHighlights(const ReaderSnapshot& snap,
                                     const std::vector<HighlightInput>& inputs) {
  ResolvedHighlights out;
  for (const HighlightInput& h : inputs) {
    const int a = snap.BlockIndex(h.fromBlockId);
    const int z = snap.BlockIndex(h.toBlockId);
    if (a < 0 || z < 0 || z < a) {
      out.invalidIds.push_back(h.id);
      continue;
    }
    const int fromOff = h.fromOffset < 0 ? 0 : SafeOffset(snap, a, h.fromOffset);
    const int toOff = h.toOffset < 0 ? snap.BlockLength(z) : SafeOffset(snap, z, h.toOffset);
    if (a == z && toOff < fromOff) {
      out.invalidIds.push_back(h.id);
      continue;
    }
    if (h.follow && out.followBlock < 0) {
      out.followBlock = a;
      out.followOffset = fromOff;
      out.followEndBlock = z;
      out.followEndOffset = toOff;
    }
    for (int i = a; i <= z; ++i) {
      if (!IsTextBlock(snap.blocks[i])) continue;
      HighlightSpan s;
      s.start = i == a ? fromOff : 0;
      s.end = i == z ? toOff : snap.BlockLength(i);
      if (s.end <= s.start) continue;
      s.style = h.style;
      s.color = h.color;
      s.hasColor = h.hasColor;
      out.byBlock[i].push_back(s);
    }
  }
  return out;
}

std::vector<PageRect> TextRangeRects(const ReaderSnapshot& snap, int block, int start, int end) {
  std::vector<PageRect> out;
  if (block < 0 || block >= static_cast<int>(snap.blocks.size()) || end <= start) return out;
  const ReaderBlock& b = snap.blocks[block];
  for (const ReaderLineBox& l : b.lines) {
    const int a = std::max(start, l.start);
    const int z = std::min(end, l.end);
    if (z <= a || l.end <= l.start) continue;
    const float len = static_cast<float>(l.end - l.start);
    const float f0 = static_cast<float>(a - l.start) / len;
    const float f1 = static_cast<float>(z - l.start) / len;
    PageRect r{l.rect[0], l.rect[1], l.rect[2], l.rect[3]};
    if (l.rect[3] > 1.5f * l.rect[2]) {  // vertical text runs top to bottom
      r.y = l.rect[1] + f0 * l.rect[3];
      r.h = (f1 - f0) * l.rect[3];
    } else {
      r.x = l.rect[0] + f0 * l.rect[2];
      r.w = (f1 - f0) * l.rect[2];
    }
    out.push_back(r);
  }
  if (!out.empty()) return out;
  if (b.hasRect) {
    out.push_back({b.rect[0], b.rect[1], b.rect[2], b.rect[3]});
  } else {
    out.push_back({0, 0, 1, 1});
  }
  return out;
}

}  // namespace reader
}  // namespace sherpa_onnx
