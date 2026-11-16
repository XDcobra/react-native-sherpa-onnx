#include "ReaderOcrText.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <unordered_map>

namespace sherpa_onnx {
namespace reader {

namespace {

/** UTF-8 byte offset ↔ UTF-16 offset walker over one string, forward only. */
class Utf16Walker {
 public:
  explicit Utf16Walker(const std::string& s) : s_(s) {}

  /** Byte offset of UTF-16 offset `target` (>= the last one asked). */
  size_t ByteAt(int target) {
    while (u16_ < target && byte_ < s_.size()) Step();
    return byte_;
  }

  /** UTF-16 offset of byte offset `target` (>= the last one asked). */
  int Utf16At(size_t target) {
    while (byte_ < target && byte_ < s_.size()) Step();
    return u16_;
  }

 private:
  void Step() {
    const unsigned char c = static_cast<unsigned char>(s_[byte_]);
    size_t len = 1;
    int units = 1;
    if (c >= 0xF0) {
      len = 4;
      units = 2;
    } else if (c >= 0xE0) {
      len = 3;
    } else if (c >= 0xC0) {
      len = 2;
    }
    byte_ = std::min(s_.size(), byte_ + len);
    u16_ += units;
  }

  const std::string& s_;
  size_t byte_ = 0;
  int u16_ = 0;
};

bool IsSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

/** "12", "xiv", "- 3 -", "Page 4", "4 / 20". */
bool LooksLikePageNumber(const std::string& t) {
  if (t.empty() || t.size() > 12) return false;
  bool digit = false;
  bool roman = true;
  for (char c : t) {
    const char l = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (std::isdigit(static_cast<unsigned char>(c))) digit = true;
    if (std::string("ivxlcdm").find(l) == std::string::npos) roman = false;
  }
  if (roman) return true;
  if (!digit) return false;
  for (char c : t) {
    const char l = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (!(std::isdigit(static_cast<unsigned char>(c)) || c == ' ' || c == '-' || c == '/' ||
          c == '.' || std::string("pageof").find(l) != std::string::npos)) {
      return false;
    }
  }
  return true;
}

void QuadBounds(const float q[8], float* x0, float* y0, float* x1, float* y1) {
  *x0 = std::min({q[0], q[2], q[4], q[6]});
  *x1 = std::max({q[0], q[2], q[4], q[6]});
  *y0 = std::min({q[1], q[3], q[5], q[7]});
  *y1 = std::max({q[1], q[3], q[5], q[7]});
}

}  // namespace

std::vector<OcrFrameBlocks> BuildOcrFrameBlocks(const TxtOfflineEntry& ocr,
                                                const TxtOcrLayout& layout) {
  std::vector<OcrFrameBlocks> out;
  std::vector<TxtOcrFrame> frames = layout.frames;
  std::sort(frames.begin(), frames.end(),
            [](const TxtOcrFrame& a, const TxtOcrFrame& b) { return a.utf16Start < b.utf16Start; });
  const std::string& text = ocr.text;
  // Spans and elements by frame (a whole book can be one buffer).
  std::unordered_map<int, std::vector<const TxtSpatialSpan*>> spansOf;
  for (const TxtSpatialSpan& s : ocr.spatialSpans) spansOf[s.frameIndex].push_back(&s);
  std::unordered_map<int, std::vector<const TxtOcrElement*>> elementsOf;
  for (const TxtOcrElement& e : layout.elements) elementsOf[e.frameIndex].push_back(&e);
  Utf16Walker walk(text);
  Utf16Walker local(text);
  for (const TxtOcrFrame& f : frames) {
    if (f.utf16End <= f.utf16Start) continue;
    OcrFrameBlocks fb;
    fb.frameIndex = f.frameIndex;
    // Paragraph pieces: split at blank lines, trimmed.
    const size_t b0 = walk.ByteAt(f.utf16Start);
    const size_t b1 = std::min(text.size(), walk.ByteAt(f.utf16End));
    std::vector<std::pair<size_t, size_t>> pieces;
    size_t start = b0;
    for (size_t i = b0; i <= b1; ++i) {
      const bool end = i == b1;
      const bool blank = !end && text[i] == '\n' && i + 1 < b1 && text[i + 1] == '\n';
      if (!end && !blank) continue;
      size_t a = start;
      size_t z = i;
      while (a < z && IsSpace(text[a])) ++a;
      while (z > a && IsSpace(text[z - 1])) --z;
      if (z > a) pieces.emplace_back(a, z);
      if (blank) {
        while (i < b1 && text[i] == '\n') ++i;
        start = i;
        --i;  // the loop's ++i
      }
    }
    const auto& frameSpans = spansOf[f.frameIndex];
    const auto& frameElements = elementsOf[f.frameIndex];
    for (const auto& [a, z] : pieces) {
      OcrTextBlock blk;
      blk.utf16Start = local.Utf16At(a);
      blk.utf16End = local.Utf16At(z);
      // The element covering most of the piece types it.
      const TxtOcrElement* best = nullptr;
      int bestOverlap = 0;
      for (const TxtOcrElement* e : frameElements) {
        if (!e->hasUtf16) continue;
        const int ov =
            std::min(e->utf16End, blk.utf16End) - std::max(e->utf16Start, blk.utf16Start);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          best = e;
        }
      }
      if (best) {
        if (best->kind == "title") {
          blk.type = ReaderBlockType::Heading;
          blk.headingLevel = 1;
        } else if (best->kind == "sectionHeader") {
          blk.type = ReaderBlockType::Heading;
          blk.headingLevel = best->headingLevel > 0 ? std::min(6, best->headingLevel) : 2;
        } else if (best->kind == "pageHeader" || best->kind == "pageFooter") {
          blk.flags |= kBlockFurniture;
        }
      }
      // Rectangle: the lines of the piece, else the element's box.
      float x0 = 1e9f, y0 = 1e9f, x1 = -1e9f, y1 = -1e9f;
      bool any = false;
      for (const TxtSpatialSpan* sp : frameSpans) {
        const TxtSpatialSpan& s = *sp;
        if (std::min(s.utf16End, blk.utf16End) <= std::max(s.utf16Start, blk.utf16Start)) continue;
        float a0, c0, a1, c1;
        QuadBounds(s.quad, &a0, &c0, &a1, &c1);
        if (f.width > 0 && f.height > 0 && s.level == "line" && a1 > a0 && c1 > c0) {
          ReaderLineBox line;
          line.start = std::max(s.utf16Start, blk.utf16Start) - blk.utf16Start;
          line.end = std::min(s.utf16End, blk.utf16End) - blk.utf16Start;
          line.rect[0] = a0 / f.width;
          line.rect[1] = c0 / f.height;
          line.rect[2] = (a1 - a0) / f.width;
          line.rect[3] = (c1 - c0) / f.height;
          blk.lines.push_back(line);
        }
        x0 = std::min(x0, a0);
        y0 = std::min(y0, c0);
        x1 = std::max(x1, a1);
        y1 = std::max(y1, c1);
        any = true;
      }
      if (!any && best && best->hasQuad) {
        QuadBounds(best->quad, &x0, &y0, &x1, &y1);
        any = true;
      }
      if (any && f.width > 0 && f.height > 0 && x1 > x0 && y1 > y0) {
        blk.hasRect = true;
        blk.rect[0] = std::clamp(x0 / f.width, 0.f, 1.f);
        blk.rect[1] = std::clamp(y0 / f.height, 0.f, 1.f);
        blk.rect[2] = std::clamp((x1 - x0) / f.width, 0.f, 1.f - blk.rect[0]);
        blk.rect[3] = std::clamp((y1 - y0) / f.height, 0.f, 1.f - blk.rect[1]);
      }
      if (!(blk.flags & kBlockFurniture) && blk.hasRect &&
          LooksLikePageNumber(text.substr(a, z - a))) {
        const float cy = blk.rect[1] + blk.rect[3] / 2;
        if (cy < 0.1f || cy > 0.9f) blk.flags |= kBlockFurniture;
      }
      fb.blocks.push_back(blk);
    }
    if (!fb.blocks.empty()) out.push_back(std::move(fb));
  }
  return out;
}

}  // namespace reader
}  // namespace sherpa_onnx
