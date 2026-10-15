/**
 * Image operations for doctr/OnnxTR packs.
 * RGB channel order (NO BGR swap — unlike ppocr).
 */
#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doctr {

struct RgbImage {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgb;  // RGB8
};

/** Bilinear resize of RGB8 image. */
RgbImage ResizeRgb(const uint8_t* rgb, int w, int h, int dst_w, int dst_h);

/**
 * NCHW float tensor: RGB planes, (v/255 - mean) / std.
 * Input is RGB8; channels stay RGB (no swap).
 * Output size = 3 * h * w.
 */
std::vector<float> SubtractMeanNormalizeRgb(
    const uint8_t* rgb,
    int w,
    int h,
    const float mean[3],
    const float stddev[3]);

/**
 * Perspective crop of RGB quad (8 floats x0..y3) → RGB crop of size out_w x out_h.
 * Same bilinear warp as ppocr but kept in RGB order.
 */
RgbImage WarpQuadRgb(
    const uint8_t* rgb,
    int src_w,
    int src_h,
    const float quad[8],
    int out_w,
    int out_h);

/** Rec resize: scale height to dst_h, scale width proportionally, pad/crop to dst_w with white. */
RgbImage AdjustRecImage(const RgbImage& src, int dst_h, int dst_w);

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
