#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ocr_test {

struct RgbImage {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgb;  // RGB8 contiguous
};

/** Load PNG/JPEG as RGB8 via stb_image. Throws std::runtime_error on failure. */
RgbImage LoadRgbImage(const std::string& path);

}  // namespace ocr_test
