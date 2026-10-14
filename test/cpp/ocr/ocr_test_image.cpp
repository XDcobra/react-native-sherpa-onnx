#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#include "ocr_test_image.h"

#include <stdexcept>

namespace ocr_test {

RgbImage LoadRgbImage(const std::string& path) {
  int w = 0;
  int h = 0;
  int comp = 0;
  unsigned char* pixels = stbi_load(path.c_str(), &w, &h, &comp, 3);
  if (!pixels) {
    throw std::runtime_error(
        std::string("LoadRgbImage failed: ") + path + " (" +
        (stbi_failure_reason() ? stbi_failure_reason() : "?") + ")");
  }
  RgbImage out;
  out.width = w;
  out.height = h;
  out.rgb.assign(pixels, pixels + static_cast<size_t>(w) * static_cast<size_t>(h) * 3);
  stbi_image_free(pixels);
  return out;
}

}  // namespace ocr_test
