#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

struct NemotronParsePatches {
  std::vector<float> patches;  // [N, 768]
  int content_h = 0;
  int content_w = 0;
  int image_h = 0;
  int image_w = 0;
  int rows = 0;
  int cols = 0;
};

/** Official LongestMaxSizeHW 2048×1664 + NaViT 16/64 pad + CLIP + 16×16 unfold. */
NemotronParsePatches PreprocessRgb(const uint8_t* rgb, int width, int height);

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
