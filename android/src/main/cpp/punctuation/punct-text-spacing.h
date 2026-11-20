#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace sherpaonnx {
namespace punct_text {

struct CodePoint {
  uint32_t cp;
  size_t start;
  size_t len;
};

/** UTF-8 to code points with their byte ranges; an invalid byte becomes U+FFFD. */
inline std::vector<CodePoint> DecodeUtf8(const std::string& s) {
  std::vector<CodePoint> out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) {
    const auto b0 = static_cast<unsigned char>(s[i]);
    size_t len = 1;
    uint32_t cp = 0xFFFD;
    if (b0 < 0x80) {
      cp = b0;
    } else if ((b0 >> 5) == 0x6 && i + 1 < s.size()) {
      len = 2;
      cp = ((b0 & 0x1Fu) << 6) | (static_cast<unsigned char>(s[i + 1]) & 0x3Fu);
    } else if ((b0 >> 4) == 0xE && i + 2 < s.size()) {
      len = 3;
      cp = ((b0 & 0x0Fu) << 12) | ((static_cast<unsigned char>(s[i + 1]) & 0x3Fu) << 6) |
           (static_cast<unsigned char>(s[i + 2]) & 0x3Fu);
    } else if ((b0 >> 3) == 0x1E && i + 3 < s.size()) {
      len = 4;
      cp = ((b0 & 0x07u) << 18) | ((static_cast<unsigned char>(s[i + 1]) & 0x3Fu) << 12) |
           ((static_cast<unsigned char>(s[i + 2]) & 0x3Fu) << 6) |
           (static_cast<unsigned char>(s[i + 3]) & 0x3Fu);
    }
    out.push_back({cp, i, len});
    i += len;
  }
  return out;
}

inline bool IsSpace(uint32_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0xA0 || c == 0x3000 ||
         (c >= 0x2000 && c <= 0x200B);
}

/** Letters and digits; marks, symbols and spaces are not. */
inline bool IsWordChar(uint32_t c) {
  if (c < 0x80) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }
  if (IsSpace(c)) return false;
  if (c <= 0xBF || c == 0xD7 || c == 0xF7) return false;  // Latin-1 marks and symbols
  if (c >= 0x2000 && c <= 0x206F) return false;            // general punctuation
  if (c >= 0x3000 && c <= 0x303F) return false;            // CJK marks
  if (c >= 0xFE30 && c <= 0xFE4F) return false;            // CJK compatibility forms
  if ((c >= 0xFF01 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) ||
      (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65)) {
    return false;                                          // fullwidth marks
  }
  return true;
}

/** Scripts written without spaces between words (Chinese, Japanese). */
inline bool IsNoSpaceScript(uint32_t c) {
  return (c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) ||
         (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) ||
         (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF66 && c <= 0xFF9F) ||
         (c >= 0x20000 && c <= 0x2FA1F);
}

inline uint32_t AsciiLower(uint32_t c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

/**
 * Puts the input's word breaks back where a punctuation model wrote marks without a
 * space ("going?to" for "going to"): between two words that had whitespace in the
 * input and only marks in the output, one space goes after the marks. Chinese and
 * Japanese get no spaces. If the letters and digits of input and output differ (the
 * model changed a word), the output is returned unchanged.
 */
inline std::string RestoreInputWordBreaks(const std::string& input, const std::string& output) {
  const auto in = DecodeUtf8(input);
  const auto outCps = DecodeUtf8(output);
  std::string result;
  result.reserve(output.size() + 16);
  size_t j = 0;
  bool started = false;
  bool outGapHasSpace = false;
  uint32_t prev = 0;
  for (const auto& o : outCps) {
    if (!IsWordChar(o.cp)) {
      if (IsSpace(o.cp)) outGapHasSpace = true;
      result.append(output, o.start, o.len);
      continue;
    }
    bool inGapHasSpace = false;
    while (j < in.size() && !IsWordChar(in[j].cp)) {
      if (IsSpace(in[j].cp)) inGapHasSpace = true;
      ++j;
    }
    if (j >= in.size() || AsciiLower(in[j].cp) != AsciiLower(o.cp)) return output;
    if (started && inGapHasSpace && !outGapHasSpace && !IsNoSpaceScript(prev) &&
        !IsNoSpaceScript(o.cp)) {
      result.push_back(' ');
    }
    result.append(output, o.start, o.len);
    prev = o.cp;
    ++j;
    started = true;
    outGapHasSpace = false;
  }
  return result;
}

}  // namespace punct_text
}  // namespace sherpaonnx
