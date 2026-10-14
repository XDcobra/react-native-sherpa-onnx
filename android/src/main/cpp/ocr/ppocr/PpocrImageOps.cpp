#include "PpocrImageOps.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {
namespace {

inline uint8_t SampleRgb(
    const uint8_t* rgb,
    int w,
    int h,
    float x,
    float y,
    int c) {
  if (w <= 0 || h <= 0) {
    return 0;
  }
  x = std::min(std::max(x, 0.f), static_cast<float>(w - 1));
  y = std::min(std::max(y, 0.f), static_cast<float>(h - 1));
  const int x0 = static_cast<int>(std::floor(x));
  const int y0 = static_cast<int>(std::floor(y));
  const int x1 = std::min(x0 + 1, w - 1);
  const int y1 = std::min(y0 + 1, h - 1);
  const float ax = x - static_cast<float>(x0);
  const float ay = y - static_cast<float>(y0);
  const auto at = [&](int xx, int yy) -> float {
    return static_cast<float>(rgb[(yy * w + xx) * 3 + c]);
  };
  const float v00 = at(x0, y0);
  const float v10 = at(x1, y0);
  const float v01 = at(x0, y1);
  const float v11 = at(x1, y1);
  const float v0 = v00 * (1.f - ax) + v10 * ax;
  const float v1 = v01 * (1.f - ax) + v11 * ax;
  return static_cast<uint8_t>(std::lround(v0 * (1.f - ay) + v1 * ay));
}

}  // namespace

ScaleParam MakeDetScale(int src_w, int src_h, int max_side_len) {
  if (src_w <= 0 || src_h <= 0) {
    throw std::invalid_argument("MakeDetScale: invalid source size");
  }
  float ratio = 1.f;
  const int long_side = std::max(src_w, src_h);
  if (long_side > max_side_len) {
    ratio = static_cast<float>(max_side_len) / static_cast<float>(long_side);
  }
  int dst_w = std::max(32, static_cast<int>(std::round(src_w * ratio)));
  int dst_h = std::max(32, static_cast<int>(std::round(src_h * ratio)));
  dst_w = (dst_w / 32) * 32;
  dst_h = (dst_h / 32) * 32;
  dst_w = std::max(dst_w, 32);
  dst_h = std::max(dst_h, 32);
  ScaleParam s;
  s.src_w = src_w;
  s.src_h = src_h;
  s.dst_w = dst_w;
  s.dst_h = dst_h;
  s.ratio_w = static_cast<float>(dst_w) / static_cast<float>(src_w);
  s.ratio_h = static_cast<float>(dst_h) / static_cast<float>(src_h);
  return s;
}

RgbImage ResizeRgb(const uint8_t* rgb, int w, int h, int dst_w, int dst_h) {
  RgbImage out;
  out.width = dst_w;
  out.height = dst_h;
  out.rgb.resize(static_cast<size_t>(dst_w) * static_cast<size_t>(dst_h) * 3);
  if (dst_w <= 0 || dst_h <= 0) {
    return out;
  }
  for (int y = 0; y < dst_h; ++y) {
    const float sy = (static_cast<float>(y) + 0.5f) * static_cast<float>(h) /
                         static_cast<float>(dst_h) -
                     0.5f;
    for (int x = 0; x < dst_w; ++x) {
      const float sx = (static_cast<float>(x) + 0.5f) * static_cast<float>(w) /
                           static_cast<float>(dst_w) -
                       0.5f;
      uint8_t* p = &out.rgb[(y * dst_w + x) * 3];
      p[0] = SampleRgb(rgb, w, h, sx, sy, 0);
      p[1] = SampleRgb(rgb, w, h, sx, sy, 1);
      p[2] = SampleRgb(rgb, w, h, sx, sy, 2);
    }
  }
  return out;
}

std::vector<float> SubtractMeanNormalize(
    const uint8_t* rgb,
    int w,
    int h,
    const float mean[3],
    const float stddev[3]) {
  const size_t plane = static_cast<size_t>(w) * static_cast<size_t>(h);
  std::vector<float> out(plane * 3);
  // RGB → BGR plane order expected by PP-OCR ONNX exports.
  constexpr int kRgbToBgr[3] = {2, 1, 0};
  for (size_t i = 0; i < plane; ++i) {
    for (int c = 0; c < 3; ++c) {
      const float v = static_cast<float>(rgb[i * 3 + kRgbToBgr[c]]) / 255.f;
      out[static_cast<size_t>(c) * plane + i] = (v - mean[c]) / stddev[c];
    }
  }
  return out;
}

RgbImage WarpQuadRgb(
    const uint8_t* rgb,
    int src_w,
    int src_h,
    const float quad[8],
    int out_w,
    int out_h) {
  RgbImage out;
  out.width = out_w;
  out.height = out_h;
  out.rgb.assign(static_cast<size_t>(out_w) * static_cast<size_t>(out_h) * 3, 255);
  if (out_w <= 0 || out_h <= 0) {
    return out;
  }
  // bilinear map unit square → quad (tl,tr,br,bl)
  const float x0 = quad[0], y0 = quad[1];
  const float x1 = quad[2], y1 = quad[3];
  const float x2 = quad[4], y2 = quad[5];
  const float x3 = quad[6], y3 = quad[7];
  for (int y = 0; y < out_h; ++y) {
    const float v = (out_h == 1) ? 0.f : static_cast<float>(y) / static_cast<float>(out_h - 1);
    for (int x = 0; x < out_w; ++x) {
      const float u = (out_w == 1) ? 0.f : static_cast<float>(x) / static_cast<float>(out_w - 1);
      const float top_x = x0 + (x1 - x0) * u;
      const float top_y = y0 + (y1 - y0) * u;
      const float bot_x = x3 + (x2 - x3) * u;
      const float bot_y = y3 + (y2 - y3) * u;
      const float sx = top_x + (bot_x - top_x) * v;
      const float sy = top_y + (bot_y - top_y) * v;
      uint8_t* p = &out.rgb[(y * out_w + x) * 3];
      p[0] = SampleRgb(rgb, src_w, src_h, sx, sy, 0);
      p[1] = SampleRgb(rgb, src_w, src_h, sx, sy, 1);
      p[2] = SampleRgb(rgb, src_w, src_h, sx, sy, 2);
    }
  }
  return out;
}

RgbImage AdjustRecImage(const RgbImage& src, int dst_h, int dst_w) {
  if (src.height <= 0 || src.width <= 0) {
    RgbImage blank;
    blank.width = dst_w;
    blank.height = dst_h;
    blank.rgb.assign(static_cast<size_t>(dst_w) * static_cast<size_t>(dst_h) * 3, 255);
    return blank;
  }
  const float scale = static_cast<float>(dst_h) / static_cast<float>(src.height);
  int scaled_w = std::max(1, static_cast<int>(std::round(src.width * scale)));
  RgbImage resized = ResizeRgb(src.rgb.data(), src.width, src.height, scaled_w, dst_h);
  RgbImage fit;
  fit.width = dst_w;
  fit.height = dst_h;
  fit.rgb.assign(static_cast<size_t>(dst_w) * static_cast<size_t>(dst_h) * 3, 255);
  const int copy_w = std::min(scaled_w, dst_w);
  for (int y = 0; y < dst_h; ++y) {
    std::copy_n(
        &resized.rgb[static_cast<size_t>(y) * static_cast<size_t>(scaled_w) * 3],
        static_cast<size_t>(copy_w) * 3,
        &fit.rgb[static_cast<size_t>(y) * static_cast<size_t>(dst_w) * 3]);
  }
  return fit;
}

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
