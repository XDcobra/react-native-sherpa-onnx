#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

struct PaddleocrVlPatches {
  /** pixel_values layout [P, 3, 14, 14] packed; caller adds batch dim. */
  std::vector<float> pixel_values;
  int src_h = 0;
  int src_w = 0;
  int resized_h = 0;
  int resized_w = 0;
  int grid_t = 1;
  int grid_h = 0;
  int grid_w = 0;
  int num_patches = 0;
};

struct SmartResizeSize {
  int height = 0;
  int width = 0;
};

constexpr int kSmartResizeFactor = 28;
constexpr int kMinPixels = 112896;
/** Official PaddleOCR-VL smart_resize ceiling (desktop / GPU). */
constexpr int kOfficialMaxPixels = 1003520;
/** Suggested phone cap (512 visual tokens). Apps pass this via maxPixels. */
constexpr int kMobileMaxPixels = 401408;

SmartResizeSize SmartResize(int height, int width, int factor = kSmartResizeFactor,
                            int min_pixels = kMinPixels,
                            int max_pixels = kOfficialMaxPixels);

/**
 * RGB8 → smart_resize + bicubic + /255 + mean/std 0.5 + 14×14 unfold, t=1.
 * `max_pixels` ≤ 0 uses kOfficialMaxPixels; values are clamped to
 * [kMinPixels, kOfficialMaxPixels].
 */
PaddleocrVlPatches PreprocessRgb(const uint8_t* rgb, int width, int height,
                                 int max_pixels = kOfficialMaxPixels);

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
