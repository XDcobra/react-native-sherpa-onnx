#include "NemotronParseNpy.h"

#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {
namespace {

constexpr size_t kTokens = 16384;
constexpr size_t kWidth = 1152;
constexpr size_t kCount = kTokens * kWidth;

uint16_t ReadU16Le(const unsigned char* p) {
  return static_cast<uint16_t>(p[0] | (static_cast<uint16_t>(p[1]) << 8));
}

uint32_t ReadU32Le(const unsigned char* p) {
  return static_cast<uint32_t>(p[0] | (static_cast<uint32_t>(p[1]) << 8) |
                               (static_cast<uint32_t>(p[2]) << 16) |
                               (static_cast<uint32_t>(p[3]) << 24));
}

bool HeaderHas(const std::string& header, const char* needle) {
  return header.find(needle) != std::string::npos;
}

float HalfToFloat(uint16_t h) {
  const uint32_t sign = static_cast<uint32_t>(h & 0x8000) << 16;
  const uint32_t exp = (h >> 10) & 0x1F;
  const uint32_t frac = h & 0x3FF;
  uint32_t bits = 0;
  if (exp == 0) {
    if (frac == 0) {
      bits = sign;
    } else {
      uint32_t f = frac;
      uint32_t e = 1;
      while ((f & 0x400) == 0) {
        f <<= 1;
        --e;
      }
      f &= 0x3FF;
      bits = sign | ((127 - 15 + e) << 23) | (f << 13);
    }
  } else if (exp == 31) {
    bits = sign | 0x7F800000 | (frac << 13);
  } else {
    bits = sign | ((exp + (127 - 15)) << 23) | (frac << 13);
  }
  float out = 0.f;
  std::memcpy(&out, &bits, sizeof(out));
  return out;
}

bool ShapeOk(const std::string& header) {
  return HeaderHas(header, "(1, 16384, 1152)") || HeaderHas(header, "(16384, 1152)") ||
         HeaderHas(header, "(1,16384,1152)") || HeaderHas(header, "(16384,1152)");
}

}  // namespace

std::vector<float> LoadPosEmbedNpy(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("NemotronParseNpy: cannot open " + path);
  }
  unsigned char magic[8];
  in.read(reinterpret_cast<char*>(magic), 8);
  if (!in || std::memcmp(magic, "\x93NUMPY", 6) != 0) {
    throw std::runtime_error("NemotronParseNpy: not a .npy file");
  }
  const int major = magic[6];
  const int minor = magic[7];
  (void)minor;
  uint32_t header_len = 0;
  if (major == 1) {
    unsigned char len[2];
    in.read(reinterpret_cast<char*>(len), 2);
    if (!in) throw std::runtime_error("NemotronParseNpy: truncated v1 header");
    header_len = ReadU16Le(len);
  } else if (major == 2 || major == 3) {
    unsigned char len[4];
    in.read(reinterpret_cast<char*>(len), 4);
    if (!in) throw std::runtime_error("NemotronParseNpy: truncated v2 header");
    header_len = ReadU32Le(len);
  } else {
    throw std::runtime_error("NemotronParseNpy: unsupported npy version");
  }
  std::string header(header_len, '\0');
  in.read(header.data(), static_cast<std::streamsize>(header_len));
  if (!in) throw std::runtime_error("NemotronParseNpy: truncated header");
  if (HeaderHas(header, "fortran_order': True") || HeaderHas(header, "fortran_order\": True")) {
    throw std::runtime_error("NemotronParseNpy: fortran_order is not supported");
  }
  if (!ShapeOk(header)) {
    throw std::runtime_error("NemotronParseNpy: expected shape (1, 16384, 1152)");
  }
  const bool is_f16 = HeaderHas(header, "<f2");
  const bool is_f32 = HeaderHas(header, "<f4");
  if (!is_f16 && !is_f32) {
    throw std::runtime_error("NemotronParseNpy: descr must be <f4 or <f2");
  }
  std::vector<float> out(kCount);
  if (is_f32) {
    in.read(reinterpret_cast<char*>(out.data()),
            static_cast<std::streamsize>(kCount * sizeof(float)));
    if (!in) throw std::runtime_error("NemotronParseNpy: truncated f32 payload");
  } else {
    std::vector<uint16_t> half(kCount);
    in.read(reinterpret_cast<char*>(half.data()),
            static_cast<std::streamsize>(kCount * sizeof(uint16_t)));
    if (!in) throw std::runtime_error("NemotronParseNpy: truncated f16 payload");
    for (size_t i = 0; i < kCount; ++i) out[i] = HalfToFloat(half[i]);
  }
  return out;
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
