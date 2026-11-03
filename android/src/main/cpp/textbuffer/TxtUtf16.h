#pragma once

/**
 * UTF-16 code-unit helpers matching JS / NSString / Kotlin String length semantics.
 * Operates on UTF-8 input strings.
 */

#include <cstdint>
#include <string>

inline int txt_utf16_length(const std::string &utf8) {
  int units = 0;
  const unsigned char *p = reinterpret_cast<const unsigned char *>(utf8.data());
  const unsigned char *end = p + utf8.size();
  while (p < end) {
    unsigned char c = *p;
    if (c < 0x80) {
      ++p;
      ++units;
    } else if ((c >> 5) == 0x6) {
      p += (p + 1 < end) ? 2 : 1;
      ++units;
    } else if ((c >> 4) == 0xE) {
      // BMP or surrogate pair lead — UTF-8 3-byte is one UTF-16 unit if U+0000..U+FFFF
      p += (p + 2 < end) ? 3 : 1;
      ++units;
    } else if ((c >> 3) == 0x1E) {
      // Supplementary plane → surrogate pair (2 UTF-16 units)
      p += (p + 3 < end) ? 4 : 1;
      units += 2;
    } else {
      ++p;
      ++units;
    }
  }
  return units;
}

/** Return UTF-8 suffix that keeps the last maxUnits UTF-16 code units. */
inline std::string txt_utf16_suffix(const std::string &utf8, int maxUnits) {
  if (maxUnits <= 0) return {};
  int total = txt_utf16_length(utf8);
  if (total <= maxUnits) return utf8;

  int skip = total - maxUnits;
  int seen = 0;
  const unsigned char *p = reinterpret_cast<const unsigned char *>(utf8.data());
  const unsigned char *end = p + utf8.size();
    while (p < end && seen < skip) {
    unsigned char c = *p;
    size_t adv = 1;
    int units = 1;
    if (c < 0x80) {
      adv = 1;
      units = 1;
    } else if ((c >> 5) == 0x6) {
      adv = (p + 1 < end) ? 2 : 1;
      units = 1;
    } else if ((c >> 4) == 0xE) {
      adv = (p + 2 < end) ? 3 : 1;
      units = 1;
    } else if ((c >> 3) == 0x1E) {
      adv = (p + 3 < end) ? 4 : 1;
      units = 2;
    }
    p += adv;
    seen += units;
  }
  return std::string(reinterpret_cast<const char *>(p), reinterpret_cast<const char *>(end));
}
