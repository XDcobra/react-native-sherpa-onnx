/**
 * utf8_lenient.h
 *
 * JNI-free lenient UTF-8 -> UTF-16 decoder used by jni_utf8.h (and host tests).
 * Invalid / truncated sequences become U+FFFD; code points above U+FFFF become
 * surrogate pairs.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace sherpaonnx {

/** Lenient UTF-8 -> UTF-16. Malformed input yields U+FFFD per offending byte run. */
inline std::u16string Utf8ToUtf16Lenient(const char* data, size_t size) {
  std::u16string out;
  out.reserve(size);
  const auto* s = reinterpret_cast<const uint8_t*>(data);
  size_t i = 0;
  constexpr char16_t kReplacement = 0xFFFD;
  while (i < size) {
    const uint8_t b0 = s[i];
    if (b0 < 0x80) {
      out.push_back(static_cast<char16_t>(b0));
      i += 1;
      continue;
    }
    size_t len = 0;
    uint32_t cp = 0;
    uint32_t min = 0;
    if ((b0 & 0xE0) == 0xC0) {
      len = 2;
      cp = b0 & 0x1F;
      min = 0x80;
    } else if ((b0 & 0xF0) == 0xE0) {
      len = 3;
      cp = b0 & 0x0F;
      min = 0x800;
    } else if ((b0 & 0xF8) == 0xF0) {
      len = 4;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      // Stray continuation byte or invalid lead byte (0xF8..0xFF).
      out.push_back(kReplacement);
      i += 1;
      continue;
    }
    size_t consumed = 1;
    bool valid = true;
    for (; consumed < len; ++consumed) {
      if (i + consumed >= size || (s[i + consumed] & 0xC0) != 0x80) {
        valid = false;  // truncated sequence (e.g. partial BPE token)
        break;
      }
      cp = (cp << 6) | (s[i + consumed] & 0x3F);
    }
    if (!valid || cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
      out.push_back(kReplacement);
      // Resume at the first byte that was not a valid continuation.
      i += valid ? len : consumed;
      continue;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<char16_t>(cp));
    }
    i += len;
  }
  return out;
}

}  // namespace sherpaonnx
