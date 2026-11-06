#pragma once

/**
 * UTF-16 code-unit ↔ UTF-8 codecs for JNI content marshaling (T2).
 * C SoT stays UTF-8; JNI uses jchar / NewString without modified UTF-8.
 */

#include "TxtUtf16.h"

#include <cstdint>
#include <string>
#include <vector>

namespace {

inline void txt_append_utf8_codepoint(std::string *out, uint32_t cp) {
  if (cp <= 0x7F) {
    out->push_back(static_cast<char>(cp));
  } else if (cp <= 0x7FF) {
    out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
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

inline bool txt_is_high_surrogate(uint16_t u) { return u >= 0xD800 && u <= 0xDBFF; }
inline bool txt_is_low_surrogate(uint16_t u) { return u >= 0xDC00 && u <= 0xDFFF; }

}  // namespace

/** Encode UTF-16 code units to UTF-8. Unpaired surrogates → U+FFFD. */
inline std::string txt_utf8_from_utf16(const uint16_t *units, size_t n) {
  std::string out;
  if (!units || n == 0) return out;
  out.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    uint16_t u = units[i];
    if (txt_is_high_surrogate(u)) {
      if (i + 1 < n && txt_is_low_surrogate(units[i + 1])) {
        uint32_t cp = 0x10000 + (((uint32_t)(u - 0xD800) << 10) | (uint32_t)(units[i + 1] - 0xDC00));
        txt_append_utf8_codepoint(&out, cp);
        ++i;
      } else {
        txt_append_utf8_codepoint(&out, 0xFFFD);
      }
    } else if (txt_is_low_surrogate(u)) {
      txt_append_utf8_codepoint(&out, 0xFFFD);
    } else {
      txt_append_utf8_codepoint(&out, u);
    }
  }
  return out;
}

/** Decode UTF-8 to UTF-16 code units. Invalid sequences → U+FFFD. */
inline std::vector<uint16_t> txt_utf16_from_utf8(const std::string &utf8) {
  std::vector<uint16_t> out;
  out.reserve((size_t)txt_utf16_length(utf8));
  const unsigned char *p = reinterpret_cast<const unsigned char *>(utf8.data());
  const unsigned char *end = p + utf8.size();
  while (p < end) {
    unsigned char c = *p;
    uint32_t cp = 0;
    size_t need = 1;
    if (c < 0x80) {
      cp = c;
      need = 1;
    } else if ((c >> 5) == 0x6) {
      need = 2;
      if (p + 1 >= end || (p[1] & 0xC0) != 0x80) {
        out.push_back(0xFFFD);
        ++p;
        continue;
      }
      cp = ((uint32_t)(c & 0x1F) << 6) | (uint32_t)(p[1] & 0x3F);
    } else if ((c >> 4) == 0xE) {
      need = 3;
      if (p + 2 >= end || (p[1] & 0xC0) != 0x80 || (p[2] & 0xC0) != 0x80) {
        out.push_back(0xFFFD);
        ++p;
        continue;
      }
      cp = ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (uint32_t)(p[2] & 0x3F);
    } else if ((c >> 3) == 0x1E) {
      need = 4;
      if (p + 3 >= end || (p[1] & 0xC0) != 0x80 || (p[2] & 0xC0) != 0x80 || (p[3] & 0xC0) != 0x80) {
        out.push_back(0xFFFD);
        ++p;
        continue;
      }
      cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(p[1] & 0x3F) << 12) |
           ((uint32_t)(p[2] & 0x3F) << 6) | (uint32_t)(p[3] & 0x3F);
    } else {
      out.push_back(0xFFFD);
      ++p;
      continue;
    }
    p += need;
    if (cp >= 0xD800 && cp <= 0xDFFF) {
      out.push_back(0xFFFD);
    } else if (cp <= 0xFFFF) {
      out.push_back(static_cast<uint16_t>(cp));
    } else if (cp <= 0x10FFFF) {
      cp -= 0x10000;
      out.push_back(static_cast<uint16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<uint16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(0xFFFD);
    }
  }
  return out;
}

/**
 * Perf keep: D-A2 — one-pass UTF-16-indexed slice → UTF-16 units (no UTF-8 substring + re-encode).
 * Same window rules as txt_utf16_slice (no splitting surrogate pairs).
 */
inline std::vector<uint16_t> txt_utf16_slice_units(const std::string &utf8, int startUnits,
                                                   int maxUnits) {
  std::vector<uint16_t> out;
  if (startUnits < 0 || maxUnits <= 0) return out;
  out.reserve(static_cast<size_t>(maxUnits));

  const unsigned char *p = reinterpret_cast<const unsigned char *>(utf8.data());
  const unsigned char *end = p + utf8.size();

  int seen = 0;
  while (p < end && seen < startUnits) {
    size_t adv = 1;
    int units = 1;
    txt_utf16_advance(p, end, &adv, &units);
    if (seen + units > startUnits) {
      p += adv;
      seen += units;
      break;
    }
    p += adv;
    seen += units;
  }
  if (seen < startUnits) return out;

  int taken = 0;
  while (p < end && taken < maxUnits) {
    unsigned char c = *p;
    uint32_t cp = 0;
    size_t need = 1;
    int units = 1;
    if (c < 0x80) {
      cp = c;
      need = 1;
      units = 1;
    } else if ((c >> 5) == 0x6) {
      need = 2;
      units = 1;
      if (p + 1 >= end || (p[1] & 0xC0) != 0x80) {
        if (taken + 1 > maxUnits) break;
        out.push_back(0xFFFD);
        ++p;
        taken += 1;
        continue;
      }
      cp = ((uint32_t)(c & 0x1F) << 6) | (uint32_t)(p[1] & 0x3F);
    } else if ((c >> 4) == 0xE) {
      need = 3;
      units = 1;
      if (p + 2 >= end || (p[1] & 0xC0) != 0x80 || (p[2] & 0xC0) != 0x80) {
        if (taken + 1 > maxUnits) break;
        out.push_back(0xFFFD);
        ++p;
        taken += 1;
        continue;
      }
      cp = ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (uint32_t)(p[2] & 0x3F);
    } else if ((c >> 3) == 0x1E) {
      need = 4;
      units = 2;
      if (p + 3 >= end || (p[1] & 0xC0) != 0x80 || (p[2] & 0xC0) != 0x80 || (p[3] & 0xC0) != 0x80) {
        if (taken + 1 > maxUnits) break;
        out.push_back(0xFFFD);
        ++p;
        taken += 1;
        continue;
      }
      cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(p[1] & 0x3F) << 12) |
           ((uint32_t)(p[2] & 0x3F) << 6) | (uint32_t)(p[3] & 0x3F);
    } else {
      if (taken + 1 > maxUnits) break;
      out.push_back(0xFFFD);
      ++p;
      taken += 1;
      continue;
    }
    if (taken + units > maxUnits) break;
    p += need;
    if (cp >= 0xD800 && cp <= 0xDFFF) {
      out.push_back(0xFFFD);
      taken += 1;
    } else if (cp <= 0xFFFF) {
      out.push_back(static_cast<uint16_t>(cp));
      taken += 1;
    } else if (cp <= 0x10FFFF) {
      cp -= 0x10000;
      out.push_back(static_cast<uint16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<uint16_t>(0xDC00 + (cp & 0x3FF)));
      taken += 2;
    } else {
      out.push_back(0xFFFD);
      taken += 1;
    }
  }
  return out;
}
