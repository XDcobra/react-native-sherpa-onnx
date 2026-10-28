#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

inline bool DecodeBase64(const std::string& in, std::vector<uint8_t>* out) {
  if (!out) return false;
  out->clear();
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  int acc = 0;
  int bits = 0;
  for (char c : in) {
    if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
    const int v = val(c);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out->push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
    }
  }
  return true;
}

}  // namespace document
}  // namespace sherpa_onnx
