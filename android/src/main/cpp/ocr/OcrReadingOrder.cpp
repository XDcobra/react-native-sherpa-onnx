#include "OcrReadingOrder.h"

#include "OcrTextUtils.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

namespace {

/** One box of the detector output: a text line (ppocr) or a word (doctr). */
struct Part {
  std::string text;
  OcrSpan span;
  float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  float h() const { return y1 - y0; }
};

/** A text line: one or more boxes side by side, in reading order. */
struct Line {
  std::string text;  // parts joined by a space (none between CJK characters)
  std::vector<Part> parts;
  float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  float w() const { return x1 - x0; }
  float h() const { return y1 - y0; }
};

/** Byte offset of a UTF-16 offset in UTF-8 text. */
size_t ByteAtUtf16(const std::string& s, int units) {
  size_t byte = 0;
  int u = 0;
  while (byte < s.size() && u < units) {
    const unsigned char c = static_cast<unsigned char>(s[byte]);
    size_t len = 1;
    int n = 1;
    if (c >= 0xF0) {
      len = 4;
      n = 2;
    } else if (c >= 0xE0) {
      len = 3;
    } else if (c >= 0xC0) {
      len = 2;
    }
    byte = std::min(s.size(), byte + len);
    u += n;
  }
  return byte;
}

uint32_t FirstCodePoint(const std::string& s) {
  if (s.empty()) return 0;
  const unsigned char c = static_cast<unsigned char>(s[0]);
  if (c < 0x80) return c;
  if (c >= 0xF0 && s.size() >= 4) {
    return ((c & 0x07u) << 18) | ((s[1] & 0x3Fu) << 12) | ((s[2] & 0x3Fu) << 6) | (s[3] & 0x3Fu);
  }
  if (c >= 0xE0 && s.size() >= 3) {
    return ((c & 0x0Fu) << 12) | ((s[1] & 0x3Fu) << 6) | (s[2] & 0x3Fu);
  }
  if (c >= 0xC0 && s.size() >= 2) return ((c & 0x1Fu) << 6) | (s[1] & 0x3Fu);
  return c;
}

uint32_t LastCodePoint(const std::string& s) {
  if (s.empty()) return 0;
  size_t i = s.size() - 1;
  while (i > 0 && (static_cast<unsigned char>(s[i]) & 0xC0u) == 0x80u) --i;
  return FirstCodePoint(s.substr(i));
}

/** Han, kana, hangul and CJK punctuation: no space when lines join. */
bool IsCjk(uint32_t cp) {
  return (cp >= 0x3000 && cp <= 0x30FF) || (cp >= 0x3400 && cp <= 0x9FFF) ||
         (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
         (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0x20000 && cp <= 0x2FFFF);
}

float Median(std::vector<float> v) {
  if (v.empty()) return 0.f;
  std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
  return v[v.size() / 2];
}

struct Gap {
  float size = 0;
  float at = 0;  // split coordinate
};

/** Width of a horizontal line's first word, estimated from its share of the characters. */
float FirstWordWidth(const Line& l) {
  size_t chars = 0;
  size_t first = 0;
  bool in_first = true;
  for (size_t i = 0; i < l.text.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(l.text[i]);
    if ((c & 0xC0u) == 0x80u) continue;  // continuation byte
    ++chars;
    if (c == ' ') in_first = false;
    if (in_first) ++first;
  }
  return chars == 0 ? 0.f : l.w() * static_cast<float>(first) / static_cast<float>(chars);
}

/** Widest gap in the projection of [lo, hi] intervals (none: size 0). */
Gap WidestGap(std::vector<std::pair<float, float>> iv) {
  Gap best;
  if (iv.size() < 2) return best;
  std::sort(iv.begin(), iv.end());
  float reach = iv[0].second;
  for (size_t i = 1; i < iv.size(); ++i) {
    if (iv[i].first > reach && iv[i].first - reach > best.size) {
      best.size = iv[i].first - reach;
      best.at = (iv[i].first + reach) / 2;
    }
    reach = std::max(reach, iv[i].second);
  }
  return best;
}

/**
 * Recursive XY cut. Horizontal text prefers a column cut once the gutter is
 * at least `min_gutter` wide; vertical text prefers a row cut likewise.
 */
/** Extent of a column: the lines of the XY-cut node after the last column cut. */
struct ColumnEdges {
  float lo = 0;  // min x0 (min y0 for vertical text)
  float hi = 0;  // max x1 (max y1 for vertical text)
};

ColumnEdges EdgesOf(const std::vector<Line>& lines, const std::vector<int>& idx, bool vertical) {
  ColumnEdges e{1e30f, -1e30f};
  for (int i : idx) {
    e.lo = std::min(e.lo, vertical ? lines[i].y0 : lines[i].x0);
    e.hi = std::max(e.hi, vertical ? lines[i].y1 : lines[i].x1);
  }
  return e;
}

void XyCut(const std::vector<Line>& lines, std::vector<int> idx, bool vertical, bool rtl,
           float min_gutter, ColumnEdges column, std::vector<ColumnEdges>* edges,
           std::vector<int>* out) {
  if (idx.size() <= 1) {
    for (int i : idx) (*edges)[i] = column;
    out->insert(out->end(), idx.begin(), idx.end());
    return;
  }
  std::vector<std::pair<float, float>> xs, ys;
  for (int i : idx) {
    xs.push_back({lines[i].x0, lines[i].x1});
    ys.push_back({lines[i].y0, lines[i].y1});
  }
  const Gap gx = WidestGap(xs);
  const Gap gy = WidestGap(ys);
  bool cut_x;
  if (gx.size <= 0 && gy.size <= 0) {
    // Overlapping boxes: fall back to a plain order.
    std::sort(idx.begin(), idx.end(), [&](int a, int b) {
      if (vertical) return rtl ? lines[a].x0 > lines[b].x0 : lines[a].x0 < lines[b].x0;
      return lines[a].y0 < lines[b].y0;
    });
    for (int i : idx) (*edges)[i] = column;
    out->insert(out->end(), idx.begin(), idx.end());
    return;
  }
  if (!vertical) {
    cut_x = gx.size >= min_gutter || gy.size <= 0;
  } else {
    cut_x = !(gy.size >= min_gutter || gx.size <= 0);
  }
  std::vector<int> first, second;
  for (int i : idx) {
    const bool before = cut_x ? lines[i].x1 <= gx.at : lines[i].y1 <= gy.at;
    (before ? first : second).push_back(i);
  }
  if (first.empty() || second.empty()) {  // degenerate; should not happen
    for (int i : idx) (*edges)[i] = column;
    out->insert(out->end(), idx.begin(), idx.end());
    return;
  }
  // Columns: left→right, or right→left for rtl and vertical text read rtl.
  if (cut_x && rtl) std::swap(first, second);
  // A cut across the reading direction starts new columns with their own edges.
  const bool column_cut = vertical ? !cut_x : cut_x;
  XyCut(lines, first, vertical, rtl, min_gutter,
        column_cut ? EdgesOf(lines, first, vertical) : column, edges, out);
  XyCut(lines, second, vertical, rtl, min_gutter,
        column_cut ? EdgesOf(lines, second, vertical) : column, edges, out);
}

/** Appends `piece` to `text`: a space between words, none between CJK characters. */
bool NeedsSpace(const std::string& prev, const std::string& next) {
  return !(IsCjk(LastCodePoint(prev)) || IsCjk(FirstCodePoint(next)));
}

/**
 * Horizontal text: boxes on the same text line, closer than a column gutter,
 * become one line (word detectors such as doctr return one box per word).
 * Boxes of a line overlap vertically by at least half the smaller height;
 * side by side they may overlap (grown boxes), each starting further on.
 */
std::vector<Line> GroupIntoLines(std::vector<Part> parts, bool rtl, float em) {
  std::sort(parts.begin(), parts.end(), [rtl](const Part& a, const Part& b) {
    return rtl ? a.x1 > b.x1 : a.x0 < b.x0;
  });
  std::vector<Line> lines;
  for (Part& p : parts) {
    int best = -1;
    float best_overlap = 0;
    for (size_t i = 0; i < lines.size(); ++i) {
      const Line& l = lines[i];
      const Part& last = l.parts.back();
      const float overlap = std::min(last.y1, p.y1) - std::max(last.y0, p.y0);
      if (overlap < 0.5f * std::min(last.h(), p.h())) continue;
      // Next in the reading direction; word boxes may overlap (detectors
      // grow them), but not by more than half.
      const float pc = (p.x0 + p.x1) / 2;
      const float lc = (last.x0 + last.x1) / 2;
      if (rtl ? pc >= lc : pc <= lc) continue;
      const float gap = rtl ? last.x0 - p.x1 : p.x0 - last.x1;
      if (gap > 0.8f * em) continue;
      if (overlap > best_overlap) {
        best = static_cast<int>(i);
        best_overlap = overlap;
      }
    }
    if (best < 0) {
      Line l;
      l.text = p.text;
      l.x0 = p.x0;
      l.y0 = p.y0;
      l.x1 = p.x1;
      l.y1 = p.y1;
      l.parts.push_back(std::move(p));
      lines.push_back(std::move(l));
      continue;
    }
    Line& l = lines[static_cast<size_t>(best)];
    if (NeedsSpace(l.text, p.text)) l.text.push_back(' ');
    l.text += p.text;
    l.x0 = std::min(l.x0, p.x0);
    l.y0 = std::min(l.y0, p.y0);
    l.x1 = std::max(l.x1, p.x1);
    l.y1 = std::max(l.y1, p.y1);
    l.parts.push_back(std::move(p));
  }
  return lines;
}

}  // namespace

void ArrangeLinesIntoParagraphs(OcrResult* r, OcrReadingDirection direction) {
  if (!r || r->spans.empty()) return;
  std::vector<Part> parts;
  parts.reserve(r->spans.size());
  for (const OcrSpan& s : r->spans) {
    if (s.level != OcrSpanLevel::kLine || s.utf16_end <= s.utf16_start) return;  // not line output
    Part p;
    const size_t a = ByteAtUtf16(r->text_utf8, s.utf16_start);
    const size_t b = ByteAtUtf16(r->text_utf8, s.utf16_end);
    p.text = r->text_utf8.substr(a, b - a);
    p.span = s;
    p.x0 = std::min({s.quad.xy[0], s.quad.xy[2], s.quad.xy[4], s.quad.xy[6]});
    p.x1 = std::max({s.quad.xy[0], s.quad.xy[2], s.quad.xy[4], s.quad.xy[6]});
    p.y0 = std::min({s.quad.xy[1], s.quad.xy[3], s.quad.xy[5], s.quad.xy[7]});
    p.y1 = std::max({s.quad.xy[1], s.quad.xy[3], s.quad.xy[5], s.quad.xy[7]});
    if (p.x1 <= p.x0 || p.y1 <= p.y0) return;  // no usable geometry
    parts.push_back(std::move(p));
  }
  const bool rtl = direction == OcrReadingDirection::kRtl;
  std::vector<float> ratios, thickness;
  for (const Part& p : parts) ratios.push_back(p.h() / (p.x1 - p.x0));
  const bool vertical = Median(ratios) > 1.5f;
  for (const Part& p : parts) thickness.push_back(vertical ? p.x1 - p.x0 : p.h());
  const float em = std::max(1.f, Median(thickness));

  std::vector<Line> lines;
  if (vertical) {
    // Vertical text (manga): every box is a column line of its own.
    for (Part& p : parts) {
      Line l;
      l.text = p.text;
      l.x0 = p.x0;
      l.y0 = p.y0;
      l.x1 = p.x1;
      l.y1 = p.y1;
      l.parts.push_back(std::move(p));
      lines.push_back(std::move(l));
    }
  } else {
    lines = GroupIntoLines(std::move(parts), rtl, em);
  }

  std::vector<int> order;
  std::vector<int> all(lines.size());
  for (size_t i = 0; i < lines.size(); ++i) all[i] = static_cast<int>(i);
  std::vector<ColumnEdges> edges(lines.size());
  XyCut(lines, all, vertical, rtl, 0.8f * em, EdgesOf(lines, all, vertical), &edges, &order);

  // Paragraphs: the next line continues the paragraph when it follows close
  // below (or beside, for vertical text) with overlapping extent, about the
  // same size and no first-line indent, and the previous line ended where the
  // next line's first word would not have fit (a line ending early — last
  // line, heading — ends a paragraph).
  std::vector<std::vector<int>> paragraphs;
  for (size_t k = 0; k < order.size(); ++k) {
    const Line& b = lines[order[k]];
    bool join = false;
    if (k > 0) {
      const Line& a = lines[order[k - 1]];
      const ColumnEdges& col = edges[order[k - 1]];
      const bool hyphenated = LastCodePoint(a.text) == '-' &&
                              FirstCodePoint(b.text) >= 'a' && FirstCodePoint(b.text) <= 'z';
      if (!vertical) {
        const float gap = b.y0 - a.y1;
        const bool overlap = std::min(a.x1, b.x1) > std::max(a.x0, b.x0);
        // A first-line indent: b starts further in but still reaches the far
        // margin (a short last line of the paragraph does not).
        const bool indent = rtl ? (a.x1 - b.x1) > em && b.x0 <= a.x0 + 2 * em
                                : (b.x0 - a.x0) > em && b.x1 >= a.x1 - 2 * em;
        // The previous line ended early: the next line's first word (plus a
        // space and some slack) would have fit after it — a typesetter's wrap.
        const float room = rtl ? (a.x0 - col.lo) : (col.hi - a.x1);
        const bool short_prev = room > FirstWordWidth(b) + 0.6f * em;
        // Lines of clearly different size (a title above body text) do not
        // join. One font varies up to ~1.3 between lines with and without
        // ascenders / descenders.
        const bool same_size = std::max(a.h(), b.h()) <= 1.4f * std::min(a.h(), b.h());
        // The next line is below (grown boxes of adjacent lines may overlap:
        // compare the middles) and close.
        const float pitch = (b.y0 + b.y1) / 2 - (a.y0 + a.y1) / 2;
        const bool below = pitch >= 0.6f * std::min(a.h(), b.h()) && gap <= 0.8f * em;
        // "exam-" + lowercase continuation: the same paragraph whatever the layout.
        join = below && overlap && same_size && (hyphenated || (!indent && !short_prev));
      } else {
        const float gap = rtl ? a.x0 - b.x1 : b.x0 - a.x1;
        const bool overlap = std::min(a.y1, b.y1) > std::max(a.y0, b.y0);
        join = gap >= -0.3f * em && gap <= 1.0f * em && overlap;
      }
    }
    if (join) {
      paragraphs.back().push_back(order[k]);
    } else {
      paragraphs.push_back({order[k]});
    }
  }

  std::string text;
  std::vector<OcrSpan> spans;
  int cursor = 0;
  for (const auto& para : paragraphs) {
    if (!text.empty()) {
      text += "\n\n";
      cursor += 2;
    }
    for (size_t j = 0; j < para.size(); ++j) {
      const Line& line = lines[para[j]];
      if (j > 0) {
        const std::string& prev = lines[para[j - 1]].text;
        const uint32_t last = LastCodePoint(prev);
        const uint32_t first = FirstCodePoint(line.text);
        const bool hyphen = last == '-' && first >= 'a' && first <= 'z' && prev.size() > 1;
        if (hyphen) {
          // "exam-" + "ple" → "example": drop the hyphen from the text so far.
          text.pop_back();
          cursor -= 1;
          if (!spans.empty()) spans.back().utf16_end -= 1;
        } else if (NeedsSpace(prev, line.text)) {
          text.push_back(' ');
          cursor += 1;
        }
      }
      // Every box keeps its own span (a word keeps its own place on the page).
      for (size_t k = 0; k < line.parts.size(); ++k) {
        const Part& part = line.parts[k];
        if (k > 0 && NeedsSpace(line.parts[k - 1].text, part.text)) {
          text.push_back(' ');
          cursor += 1;
        }
        OcrSpan span = part.span;
        span.utf16_start = cursor;
        text += part.text;
        cursor += Utf8ToUtf16Length(part.text);
        span.utf16_end = cursor;
        spans.push_back(span);
      }
    }
  }
  r->text_utf8 = std::move(text);
  r->spans = std::move(spans);
}

}  // namespace ocr
}  // namespace sherpa_onnx
