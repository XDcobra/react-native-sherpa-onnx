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

inline void txt_utf16_advance(const unsigned char *p, const unsigned char *end, size_t *adv,
                              int *units) {
  unsigned char c = *p;
  if (c < 0x80) {
    *adv = 1;
    *units = 1;
  } else if ((c >> 5) == 0x6) {
    *adv = (p + 1 < end) ? 2 : 1;
    *units = 1;
  } else if ((c >> 4) == 0xE) {
    *adv = (p + 2 < end) ? 3 : 1;
    *units = 1;
  } else if ((c >> 3) == 0x1E) {
    *adv = (p + 3 < end) ? 4 : 1;
    *units = 2;
  } else {
    *adv = 1;
    *units = 1;
  }
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
    size_t adv = 1;
    int units = 1;
    txt_utf16_advance(p, end, &adv, &units);
    p += adv;
    seen += units;
  }
  return std::string(reinterpret_cast<const char *>(p), reinterpret_cast<const char *>(end));
}

/**
 * UTF-8 substring covering [startUnits, startUnits+maxUnits) in UTF-16 code units.
 * Empty if startUnits >= length or maxUnits <= 0.
 * Does not split supplementary-plane characters (needs 2 units): if the remaining
 * budget cannot fit both units, the character is omitted.
 */
inline std::string txt_utf16_slice(const std::string &utf8, int startUnits, int maxUnits) {
  if (startUnits < 0 || maxUnits <= 0) return {};
  const unsigned char *p = reinterpret_cast<const unsigned char *>(utf8.data());
  const unsigned char *end = p + utf8.size();

  int seen = 0;
  while (p < end && seen < startUnits) {
    size_t adv = 1;
    int units = 1;
    txt_utf16_advance(p, end, &adv, &units);
    if (seen + units > startUnits) {
      // startUnits falls inside a surrogate pair — skip the whole codepoint.
      p += adv;
      seen += units;
      break;
    }
    p += adv;
    seen += units;
  }
  if (seen < startUnits) return {};

  const unsigned char *sliceStart = p;
  int taken = 0;
  while (p < end && taken < maxUnits) {
    size_t adv = 1;
    int units = 1;
    txt_utf16_advance(p, end, &adv, &units);
    if (taken + units > maxUnits) break;
    p += adv;
    taken += units;
  }
  if (taken == 0) return {};
  return std::string(reinterpret_cast<const char *>(sliceStart), reinterpret_cast<const char *>(p));
}
