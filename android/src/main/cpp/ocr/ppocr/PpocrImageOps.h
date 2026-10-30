#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {

struct RgbImage {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgb;  // RGB8
};

struct ScaleParam {
  int src_w = 0;
  int src_h = 0;
  int dst_w = 0;
  int dst_h = 0;
  float ratio_w = 1.f;
  float ratio_h = 1.f;
};

ScaleParam MakeDetScale(int src_w, int src_h, int max_side_len);

/** Resize RGB nearest/bilinear → RGB. */
RgbImage ResizeRgb(const uint8_t* rgb, int w, int h, int dst_w, int dst_h);

/**
 * NCHW float tensor for Paddle OCR: BGR planes, (v/255 - mean) / std.
 * Input is RGB8; channels are swapped to BGR. mean/std length 3.
 * Output size = 3 * h * w.
 */
std::vector<float> SubtractMeanNormalize(
    const uint8_t* rgb,
    int w,
    int h,
    const float mean[3],
    const float stddev[3]);

/** Perspective crop of RGB quad (8 floats x0..y3) → RGB crop of size out_w x out_h. */
RgbImage WarpQuadRgb(
    const uint8_t* rgb,
    int src_w,
    int src_h,
    const float quad[8],
    int out_w,
    int out_h);

/** Rec resize: height=48, width padded/truncated to max_w, white pad. */
RgbImage AdjustRecImage(const RgbImage& src, int dst_h, int dst_w);

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
