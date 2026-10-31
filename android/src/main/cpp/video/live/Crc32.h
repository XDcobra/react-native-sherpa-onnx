#pragma once

#include <cstdint>
#include <cstddef>

namespace sherpa_onnx {
namespace video {

inline uint32_t Crc32(const uint8_t* data, size_t n) {
  uint32_t c = 0xffffffffu;
  for (size_t i = 0; i < n; ++i) {
    c ^= data[i];
    for (int b = 0; b < 8; ++b) {
      c = (c & 1) ? (c >> 1) ^ 0xedb88320u : (c >> 1);
    }
  }
  return c ^ 0xffffffffu;
}

}  // namespace video
}  // namespace sherpa_onnx
