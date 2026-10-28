#pragma once

#include <string>

namespace sherpa_onnx {
namespace document {

/** UTF-16 code unit length of UTF-8 (matches JS String.length, including surrogates). */
inline int Utf16LengthOfUtf8(const std::string& utf8) {
  int n = 0;
  for (size_t i = 0; i < utf8.size();) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    if (c < 0x80) {
      i += 1;
      n += 1;
    } else if ((c >> 5) == 0x6) {
      i += 2;
      n += 1;
    } else if ((c >> 4) == 0xE) {
      i += 3;
      n += 1;
    } else if ((c >> 3) == 0x1E) {
      i += 4;
      n += 2;
    } else {
      i += 1;
      n += 1;
    }
  }
  return n;
}

inline std::string TrimWs(const std::string& s) {
  size_t a = 0;
  while (a < s.size() &&
         (s[a] == ' ' || s[a] == '\t' || s[a] == '\n' || s[a] == '\r')) {
    ++a;
  }
  size_t b = s.size();
  while (b > a &&
         (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\n' ||
          s[b - 1] == '\r')) {
    --b;
  }
  return s.substr(a, b - a);
}

inline bool IsWsOnly(const std::string& s) { return TrimWs(s).empty(); }

}  // namespace document
}  // namespace sherpa_onnx
