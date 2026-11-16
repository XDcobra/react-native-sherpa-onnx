#include "ReaderTextHash.h"

#include "../crypto/sha256.h"

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace reader {

namespace {

constexpr uint32_t kReplacement = 0xFFFD;

/** UTF-8 → code points; any invalid / truncated sequence yields U+FFFD for one byte. */
std::vector<uint32_t> DecodeUtf8(const std::string& s) {
  std::vector<uint32_t> out;
  out.reserve(s.size());
  const auto* p = reinterpret_cast<const unsigned char*>(s.data());
  const size_t n = s.size();
  size_t i = 0;
  while (i < n) {
    const unsigned char c = p[i];
    uint32_t cp = 0;
    size_t len = 0;
    uint32_t min = 0;
    if (c < 0x80) {
      cp = c;
      len = 1;
    } else if ((c & 0xE0) == 0xC0) {
      cp = c & 0x1F;
      len = 2;
      min = 0x80;
    } else if ((c & 0xF0) == 0xE0) {
      cp = c & 0x0F;
      len = 3;
      min = 0x800;
    } else if ((c & 0xF8) == 0xF0) {
      cp = c & 0x07;
      len = 4;
      min = 0x10000;
    } else {
      out.push_back(kReplacement);
      ++i;
      continue;
    }
    if (i + len > n) {
      out.push_back(kReplacement);
      ++i;
      continue;
    }
    bool ok = true;
    for (size_t k = 1; k < len; ++k) {
      if ((p[i + k] & 0xC0) != 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (p[i + k] & 0x3F);
    }
    if (!ok || cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
      out.push_back(kReplacement);
      ++i;
      continue;
    }
    out.push_back(cp);
    i += len;
  }
  return out;
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

bool IsDropped(uint32_t cp) {
  return cp == 0x00AD || (cp >= 0x200B && cp <= 0x200D) || cp == 0x2060 || cp == 0xFEFF;
}

bool IsSingleQuote(uint32_t cp) {
  switch (cp) {
    case 0x2018: case 0x2019: case 0x201A: case 0x201B: case 0x2032:
    case 0x02BC: case 0x0060: case 0x00B4: case 0x2039: case 0x203A:
      return true;
    default:
      return false;
  }
}

bool IsDoubleQuote(uint32_t cp) {
  return (cp >= 0x201C && cp <= 0x201F) || cp == 0x2033 || cp == 0x00AB || cp == 0x00BB;
}

bool IsDash(uint32_t cp) { return (cp >= 0x2010 && cp <= 0x2015) || cp == 0x2212; }

bool IsSpace(uint32_t cp) {
  return (cp >= 0x0009 && cp <= 0x000D) || cp == 0x0020 || cp == 0x0085 || cp == 0x00A0 ||
         cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp == 0x2028 || cp == 0x2029 ||
         cp == 0x202F || cp == 0x205F || cp == 0x3000;
}

}  // namespace

std::string NormalizeForHashV1(const std::string& utf8) {
  std::string out;
  out.reserve(utf8.size());
  bool pending_space = false;
  for (uint32_t cp : DecodeUtf8(utf8)) {
    if (IsDropped(cp)) continue;
    if (IsSpace(cp)) {
      pending_space = !out.empty();
      continue;
    }
    if (pending_space) {
      out.push_back(' ');
      pending_space = false;
    }
    if (IsSingleQuote(cp)) {
      out.push_back('\'');
    } else if (IsDoubleQuote(cp)) {
      out.push_back('"');
    } else if (IsDash(cp)) {
      out.push_back('-');
    } else if (cp == 0x2026) {
      out += "...";
    } else {
      AppendUtf8(&out, cp);
    }
  }
  return out;  // trailing space never emitted; leading skipped
}

std::string ShortSha256Hex(const std::string& bytes) {
  crypto::Sha256Context ctx;
  crypto::sha256_init(&ctx);
  crypto::sha256_update(&ctx, reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  uint8_t digest[32];
  crypto::sha256_final(&ctx, digest);
  static const char* kHex = "0123456789abcdef";
  std::string hex;
  hex.reserve(16);
  for (int i = 0; i < 8; ++i) {
    hex.push_back(kHex[digest[i] >> 4]);
    hex.push_back(kHex[digest[i] & 0xF]);
  }
  return hex;
}

std::string TextHashV1(const std::string& utf8) { return ShortSha256Hex(NormalizeForHashV1(utf8)); }

std::string ImageHashV1(const std::string& href) { return ShortSha256Hex("\x1Fimage:" + href); }

std::string SeparatorHashV1() { return ShortSha256Hex("\x1Fseparator"); }

}  // namespace reader
}  // namespace sherpa_onnx
