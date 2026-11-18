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

// ---- Abbreviations ----------------------------------------------------------

bool IsDigit(uint32_t cp) { return cp >= '0' && cp <= '9'; }

/** Upper-case letters: ASCII, Latin-1, Latin Extended-A (even), Greek, Cyrillic. */
bool IsUpper(uint32_t cp) {
  return (cp >= 'A' && cp <= 'Z') || (cp >= 0xC0 && cp <= 0xDE && cp != 0xD7) ||
         (cp >= 0x100 && cp <= 0x17F && cp % 2 == 0) || (cp >= 0x391 && cp <= 0x3A9) ||
         (cp >= 0x400 && cp <= 0x42F);
}

bool IsLower(uint32_t cp) {
  return (cp >= 'a' && cp <= 'z') || (cp >= 0xDF && cp <= 0xFF && cp != 0xF7) ||
         (cp >= 0x100 && cp <= 0x17F && cp % 2 == 1) || (cp >= 0x3B1 && cp <= 0x3C9) ||
         (cp >= 0x430 && cp <= 0x45F);
}

/** How an abbreviation before `. ` lets the sentence go on. */
enum class Abbr {
  BeforeWord,    // before any word or number (titles, `e.g.`, `vgl.`)
  BeforeNumber,  // only before a digit (`No. 5`, `S. 12`)
  BeforeLower,   // only before a lower-case word or a digit (`etc.`, `usw.`)
};

struct AbbrEntry {
  const char* word;  // without the final dot
  Abbr kind;
};

// Lower-case entries also match with a capital first letter (`Vgl.` at the
// start of a sentence); capitalized ones match exactly.
constexpr AbbrEntry kAbbreviations[] = {
    // English titles and references
    {"Mr", Abbr::BeforeWord}, {"Mrs", Abbr::BeforeWord}, {"Ms", Abbr::BeforeWord},
    {"Messrs", Abbr::BeforeWord}, {"Dr", Abbr::BeforeWord}, {"Prof", Abbr::BeforeWord},
    {"St", Abbr::BeforeWord}, {"Mt", Abbr::BeforeWord}, {"Capt", Abbr::BeforeWord},
    {"Col", Abbr::BeforeWord}, {"Gen", Abbr::BeforeWord}, {"Lt", Abbr::BeforeWord},
    {"Rev", Abbr::BeforeWord}, {"Hon", Abbr::BeforeWord}, {"vs", Abbr::BeforeWord},
    {"cf", Abbr::BeforeWord}, {"e.g", Abbr::BeforeWord}, {"i.e", Abbr::BeforeWord},
    {"Fig", Abbr::BeforeNumber}, {"No", Abbr::BeforeNumber}, {"Vol", Abbr::BeforeNumber},
    {"etc", Abbr::BeforeLower}, {"Sr", Abbr::BeforeLower}, {"Jr", Abbr::BeforeLower},
    // German
    {"Hr", Abbr::BeforeWord}, {"Hrn", Abbr::BeforeWord}, {"Fr", Abbr::BeforeWord},
    {"z.B", Abbr::BeforeWord}, {"d.h", Abbr::BeforeWord}, {"vgl", Abbr::BeforeWord},
    {"ggf", Abbr::BeforeWord}, {"evtl", Abbr::BeforeWord}, {"inkl", Abbr::BeforeWord},
    {"bzgl", Abbr::BeforeWord}, {"bzw", Abbr::BeforeWord}, {"ca", Abbr::BeforeWord},
    {"Nr", Abbr::BeforeNumber}, {"S", Abbr::BeforeNumber}, {"Bd", Abbr::BeforeNumber},
    {"u.a", Abbr::BeforeLower}, {"usw", Abbr::BeforeLower}, {"Str", Abbr::BeforeLower},
    {"Jh", Abbr::BeforeLower}, {"Jhd", Abbr::BeforeLower},
};

/** Words after an ordinal (`1. Januar`, `19. Jahrhundert`) that keep the sentence going. */
constexpr const char* kAfterOrdinal[] = {
    "Januar", "Februar", "M\xC3\xA4rz", "April",    "Mai",      "Juni",     "Juli",
    "August", "September", "Oktober", "November", "Dezember", "Jahrhundert", "Jh", "Jhd",
};

bool MatchesEntry(const std::string& word, const char* entry) {
  if (word == entry) return true;
  if (entry[0] >= 'a' && entry[0] <= 'z' && !word.empty() && word[0] == entry[0] - 32) {
    return word.compare(1, std::string::npos, entry + 1) == 0;
  }
  return false;
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

/** A letter, digit or inner dot of the word before a period. */
bool IsWordChar(uint32_t cp) { return cp == '.' || IsDigit(cp) || IsUpper(cp) || IsLower(cp); }

/** The letters of `cps` from `from`, as UTF-8. */
std::string LettersAt(const std::vector<CodePoint>& cps, size_t from) {
  std::string out;
  for (size_t k = from; k < cps.size() && (IsUpper(cps[k].cp) || IsLower(cps[k].cp)); ++k) {
    AppendUtf8(&out, cps[k].cp);
  }
  return out;
}

/**
 * Whether the single `.` at `dot` (followed by whitespace) does not end the
 * sentence: an abbreviation, an initial (`J. R. R. Tolkien`) or a German
 * ordinal (`1. Januar`) with the next word on the same line.
 */
bool PeriodContinues(const std::vector<CodePoint>& cps, size_t dot) {
  const size_t n = cps.size();
  size_t next = dot + 1;
  while (next < n && IsSpace(cps[next].cp)) {
    if (IsLineBreak(cps[next].cp)) return false;
    ++next;
  }
  if (next >= n) return false;  // the end of the text ends the sentence
  const uint32_t nc = cps[next].cp;
  const bool nextUpper = IsUpper(nc);
  const bool nextLower = IsLower(nc);
  const bool nextDigit = IsDigit(nc);
  if (!nextUpper && !nextLower && !nextDigit) return false;

  size_t begin = dot;
  while (begin > 0 && IsWordChar(cps[begin - 1].cp)) --begin;
  if (begin == dot) return false;
  std::string before;
  for (size_t k = begin; k < dot; ++k) AppendUtf8(&before, cps[k].cp);

  bool allDigits = true;
  for (size_t k = begin; k < dot; ++k) allDigits = allDigits && IsDigit(cps[k].cp);
  if (allDigits) {  // ordinal: `3. und`, `1. Januar`
    if (dot - begin > 3) return false;
    if (nextLower) return true;
    const std::string after = LettersAt(cps, next);
    for (const char* w : kAfterOrdinal) {
      if (after == w) return true;
    }
    return false;
  }
  // A single capital other than the pronoun `I`, before a capital: an initial.
  if (dot - begin == 1 && IsUpper(cps[begin].cp) && cps[begin].cp != 'I' && nextUpper) {
    return true;
  }
  for (const AbbrEntry& e : kAbbreviations) {
    if (!MatchesEntry(before, e.word)) continue;
    switch (e.kind) {
      case Abbr::BeforeWord:
        return true;
      case Abbr::BeforeNumber:
        return nextDigit;
      case Abbr::BeforeLower:
        return nextLower || nextDigit;
    }
  }
  return false;
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
    bool ends = !IsAsciiMark(c.cp) || j == n || IsSpace(cps[j].cp);
    if (ends && c.cp == '.' && j == i + 1 && PeriodContinues(cps, i)) ends = false;
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
