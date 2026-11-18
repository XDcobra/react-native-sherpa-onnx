#include "ReaderSentences.h"

#include <algorithm>
#include <cstdint>
#include <cstring>

namespace sherpa_onnx {
namespace reader {

namespace {

struct CodePoint {
  uint32_t cp;
  int pos;    // UTF-16 offset
  int units;  // UTF-16 length (1 or 2)
};

/** Decodes UTF-8 into code points with UTF-16 positions (invalid bytes count as one unit each). */
std::vector<CodePoint> Decode(const std::string& s) {
  std::vector<CodePoint> out;
  out.reserve(s.size());
  const auto* p = reinterpret_cast<const unsigned char*>(s.data());
  const size_t n = s.size();
  size_t i = 0;
  int pos = 0;
  while (i < n) {
    const unsigned char c = p[i];
    uint32_t cp = c;
    size_t adv = 1;
    if (c >= 0xC0 && c < 0xE0 && i + 1 < n) {
      cp = ((c & 0x1Fu) << 6) | (p[i + 1] & 0x3Fu);
      adv = 2;
    } else if (c >= 0xE0 && c < 0xF0 && i + 2 < n) {
      cp = ((c & 0x0Fu) << 12) | ((p[i + 1] & 0x3Fu) << 6) | (p[i + 2] & 0x3Fu);
      adv = 3;
    } else if (c >= 0xF0 && c < 0xF8 && i + 3 < n) {
      cp = ((c & 0x07u) << 18) | ((p[i + 1] & 0x3Fu) << 12) | ((p[i + 2] & 0x3Fu) << 6) |
           (p[i + 3] & 0x3Fu);
      adv = 4;
    }
    const int units = adv == 4 ? 2 : 1;
    out.push_back({cp, pos, units});
    pos += units;
    i += adv;
  }
  return out;
}

bool IsLineBreak(uint32_t cp) { return cp == '\n' || cp == '\r' || cp == 0x2028 || cp == 0x2029; }

bool IsSpace(uint32_t cp) {
  return cp == ' ' || cp == '\t' || cp == '\f' || cp == '\v' || IsLineBreak(cp) || cp == 0xA0 ||
         cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp == 0x202F || cp == 0x205F ||
         cp == 0x3000 || cp == 0xFEFF;
}

/** The default sentence boundaries of the text segmentation, without the line break. */
bool IsMark(uint32_t cp) {
  switch (cp) {
    case '.':
    case '!':
    case '?':
    case ';':
    case ':':
    case 0x3002:  // 。
    case 0xFF01:  // ！
    case 0xFF1F:  // ？
    case 0xFF61:  // ｡
    case 0x061F:  // ؟
    case 0x0964:  // ।
    case 0x0965:  // ॥
      return true;
    default:
      return false;
  }
}

bool IsAsciiMark(uint32_t cp) { return cp < 0x80 && IsMark(cp); }

/** Closing quotes and brackets that stay with the sentence before them. */
bool IsClosing(uint32_t cp) {
  switch (cp) {
    case '"':
    case '\'':
    case ')':
    case ']':
    case '}':
    case 0x201D:  // ”
    case 0x2019:  // ’
    case 0x00BB:  // »
    case 0x203A:  // ›
    case 0x300D:  // 」
    case 0x300F:  // 』
    case 0x3009:  // 〉
    case 0x300B:  // 》
    case 0x3011:  // 】
    case 0x3015:  // 〕
    case 0xFF09:  // ）
      return true;
    default:
      return false;
  }
}

bool IsTextBlock(const ReaderBlock& b) {
  return b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading;
}

}  // namespace

std::vector<SentenceRange> SplitSentences(const std::string& utf8) {
  std::vector<SentenceRange> out;
  const std::vector<CodePoint> cps = Decode(utf8);
  const size_t n = cps.size();
  int start = -1;
  int end = 0;
  auto flush = [&]() {
    if (start >= 0 && end > start) out.push_back({start, end});
    start = -1;
  };
  for (size_t i = 0; i < n; ++i) {
    const CodePoint& c = cps[i];
    if (IsLineBreak(c.cp)) {
      flush();
      continue;
    }
    if (IsSpace(c.cp)) continue;
    if (start < 0) start = c.pos;
    end = c.pos + c.units;
    if (!IsMark(c.cp)) continue;
    // The run of marks and closing quotes / brackets stays with the sentence.
    size_t j = i + 1;
    while (j < n && (IsMark(cps[j].cp) || IsClosing(cps[j].cp))) {
      end = cps[j].pos + cps[j].units;
      ++j;
    }
    const bool ends = !IsAsciiMark(c.cp) || j == n || IsSpace(cps[j].cp);
    i = j - 1;
    if (ends) flush();
  }
  flush();
  return out;
}

std::vector<SentenceRange> BlockSentences(const ReaderSnapshot& snap, int block) {
  if (block < 0 || block >= static_cast<int>(snap.blocks.size())) return {};
  if (!IsTextBlock(snap.blocks[block])) return {};
  return SplitSentences(snap.BlockText(block));
}

SelectionSnap SelectionSnapFromName(const char* name) {
  if (name && std::strcmp(name, "sentence") == 0) return SelectionSnap::Sentence;
  if (name && std::strcmp(name, "block") == 0) return SelectionSnap::Block;
  return SelectionSnap::None;
}

SentenceRange SnapRange(const ReaderSnapshot& snap, int block, int start, int end,
                        SelectionSnap mode) {
  if (block < 0 || block >= static_cast<int>(snap.blocks.size())) return {0, 0};
  const int len = snap.BlockLength(block);
  const int s = std::max(0, std::min(start, len));
  const int e = std::max(s, std::min(end, len));
  if (mode == SelectionSnap::Block) return {0, len};
  if (mode == SelectionSnap::None) return {s, e};
  const std::vector<SentenceRange> sents = BlockSentences(snap, block);
  if (sents.empty()) return {s, e};
  const int count = static_cast<int>(sents.size());
  // First sentence ending after `s`: the one holding it, or the next.
  int a = static_cast<int>(
      std::partition_point(sents.begin(), sents.end(),
                           [s](const SentenceRange& r) { return r.end <= s; }) -
      sents.begin());
  if (a >= count) a = count - 1;
  // Last sentence starting before `e` (a caret counts as one character).
  const int last = std::max(e, s + 1);
  int b = static_cast<int>(
              std::partition_point(sents.begin(), sents.end(),
                                   [last](const SentenceRange& r) { return r.start < last; }) -
              sents.begin()) -
          1;
  if (b < a) b = a;  // the range lies in a gap: the next sentence
  return {sents[a].start, sents[b].end};
}

SentenceRange EnclosingSentences(const ReaderSnapshot& snap, int block, int start, int end) {
  return SnapRange(snap, block, start, end, SelectionSnap::Sentence);
}

}  // namespace reader
}  // namespace sherpa_onnx
