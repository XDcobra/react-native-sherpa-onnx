#pragma once

#include <cstdint>
#include <cstdio>
#include <random>
#include <string>

namespace sherpa_onnx {
namespace video {

inline std::string UuidV4() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  const uint64_t a = dist(rng);
  const uint64_t b = dist(rng);
  char buf[37];
  std::snprintf(buf, sizeof(buf), "%08x-%04x-%04x-%04x-%012llx",
                static_cast<unsigned>(a & 0xffffffffu),
                static_cast<unsigned>((a >> 32) & 0xffffu),
                static_cast<unsigned>(0x4000u | ((a >> 48) & 0x0fffu)),
                static_cast<unsigned>(0x8000u | ((b >> 48) & 0x3fffu)),
                static_cast<unsigned long long>(b & 0xffffffffffffull));
  return buf;
}

}  // namespace video
}  // namespace sherpa_onnx
