#include "PaddleocrVlImageOps.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {
namespace {

constexpr int kFactor = kSmartResizeFactor;
constexpr int kPatch = 14;
constexpr int kMerge = 2;
constexpr float kMean = 0.5f;
constexpr float kStd = 0.5f;

int RoundToEvenTies(double v) {
  return static_cast<int>(std::nearbyint(v));
}

double CubicWeight(double x) {
  constexpr double a = -0.5;
  const double ax = std::abs(x);
  if (ax <= 1.0) {
    return ((a + 2.0) * ax - (a + 3.0)) * ax * ax + 1.0;
  }
  if (ax < 2.0) {
    return (((a * ax - 5.0 * a) * ax) + 8.0 * a) * ax - 4.0 * a;
  }
  return 0.0;
}

uint8_t Clamp8(double v) {
  if (v <= 0.0) return 0;
  if (v >= 255.0) return 255;
  return static_cast<uint8_t>(std::lround(v));
}

int ReflectIndex(int i, int n) {
  if (n <= 1) return 0;
  if (i < 0) i = -i;
  if (i >= n) {
    const int period = 2 * n - 2;
    i %= period;
    if (i >= n) i = period - i;
  }
  return i;
}

std::vector<uint8_t> ResizeBicubic(const uint8_t* src, int src_w, int src_h, int dst_w,
                                   int dst_h) {
  std::vector<uint8_t> dst(static_cast<size_t>(dst_w) * dst_h * 3);
  const double scale_x = static_cast<double>(src_w) / static_cast<double>(dst_w);
  const double scale_y = static_cast<double>(src_h) / static_cast<double>(dst_h);
  for (int y = 0; y < dst_h; ++y) {
    const double src_y = (static_cast<double>(y) + 0.5) * scale_y - 0.5;
    const int y0 = static_cast<int>(std::floor(src_y));
    for (int x = 0; x < dst_w; ++x) {
      const double src_x = (static_cast<double>(x) + 0.5) * scale_x - 0.5;
      const int x0 = static_cast<int>(std::floor(src_x));
      double acc[3] = {0, 0, 0};
      double wsum = 0.0;
      for (int ky = -1; ky <= 2; ++ky) {
        const int sy = ReflectIndex(y0 + ky, src_h);
        const double wy = CubicWeight(src_y - static_cast<double>(y0 + ky));
        for (int kx = -1; kx <= 2; ++kx) {
          const int sx = ReflectIndex(x0 + kx, src_w);
          const double w = wy * CubicWeight(src_x - static_cast<double>(x0 + kx));
          const uint8_t* p = src + (static_cast<size_t>(sy) * src_w + sx) * 3;
          acc[0] += w * p[0];
          acc[1] += w * p[1];
          acc[2] += w * p[2];
          wsum += w;
        }
      }
      uint8_t* out = dst.data() + (static_cast<size_t>(y) * dst_w + x) * 3;
      if (wsum == 0.0) wsum = 1.0;
      out[0] = Clamp8(acc[0] / wsum);
      out[1] = Clamp8(acc[1] / wsum);
      out[2] = Clamp8(acc[2] / wsum);
    }
  }
  return dst;
}

int ClampMaxPixels(int max_pixels) {
  int cap = max_pixels <= 0 ? kOfficialMaxPixels : max_pixels;
  if (cap > kOfficialMaxPixels) cap = kOfficialMaxPixels;
  if (cap < kMinPixels) cap = kMinPixels;
  return cap;
}

}  // namespace

SmartResizeSize SmartResize(int height, int width, int factor, int min_pixels,
                            int max_pixels) {
  if (height <= 0 || width <= 0) {
    throw std::invalid_argument("PaddleocrVlImageOps: empty image");
  }
  if (factor <= 0) {
    throw std::invalid_argument("PaddleocrVlImageOps: factor must be positive");
  }
  if (height < factor) {
    width = RoundToEvenTies((static_cast<double>(width) * factor) / height);
    height = factor;
  }
  if (width < factor) {
    height = RoundToEvenTies((static_cast<double>(height) * factor) / width);
    width = factor;
  }
  const int hi = std::max(height, width);
  const int lo = std::min(height, width);
  if (lo > 0 && static_cast<double>(hi) / static_cast<double>(lo) > 200.0) {
    throw std::invalid_argument("PaddleocrVlImageOps: absolute aspect ratio must be < 200");
  }
  int h_bar = RoundToEvenTies(static_cast<double>(height) / factor) * factor;
  int w_bar = RoundToEvenTies(static_cast<double>(width) / factor) * factor;
  const double area = static_cast<double>(h_bar) * w_bar;
  if (area > max_pixels) {
    const double beta = std::sqrt((static_cast<double>(height) * width) / max_pixels);
    h_bar = static_cast<int>(std::floor(height / beta / factor)) * factor;
    w_bar = static_cast<int>(std::floor(width / beta / factor)) * factor;
  } else if (area < min_pixels) {
    const double beta = std::sqrt(min_pixels / (static_cast<double>(height) * width));
    h_bar = static_cast<int>(std::ceil(height * beta / factor)) * factor;
    w_bar = static_cast<int>(std::ceil(width * beta / factor)) * factor;
  }
  if (h_bar < factor) h_bar = factor;
  if (w_bar < factor) w_bar = factor;
  return SmartResizeSize{h_bar, w_bar};
}

PaddleocrVlPatches PreprocessRgb(const uint8_t* rgb, int width, int height,
                                 int max_pixels) {
  if (rgb == nullptr || width <= 0 || height <= 0) {
    throw std::invalid_argument("PaddleocrVlImageOps: invalid frame");
  }
  const int cap = ClampMaxPixels(max_pixels);
  const SmartResizeSize size = SmartResize(height, width, kFactor, kMinPixels, cap);
  const std::vector<uint8_t> resized =
      ResizeBicubic(rgb, width, height, size.width, size.height);

  const int grid_h = size.height / kPatch;
  const int grid_w = size.width / kPatch;
  const int num_patches = grid_h * grid_w;
  PaddleocrVlPatches out;
  out.src_h = height;
  out.src_w = width;
  out.resized_h = size.height;
  out.resized_w = size.width;
  out.grid_t = 1;
  out.grid_h = grid_h;
  out.grid_w = grid_w;
  out.num_patches = num_patches;
  out.pixel_values.assign(static_cast<size_t>(num_patches) * 3 * kPatch * kPatch, 0.f);

  auto at = [&](int y, int x, int c) -> float {
    const uint8_t v = resized[(static_cast<size_t>(y) * size.width + x) * 3 + c];
    return (static_cast<float>(v) / 255.f - kMean) / kStd;
  };

  // Unfold: p = h * grid_w + w; layout [P, 3, 14, 14]
  for (int gh = 0; gh < grid_h; ++gh) {
    for (int gw = 0; gw < grid_w; ++gw) {
      const int p = gh * grid_w + gw;
      float* patch = out.pixel_values.data() + static_cast<size_t>(p) * 3 * kPatch * kPatch;
      for (int c = 0; c < 3; ++c) {
        for (int ph = 0; ph < kPatch; ++ph) {
          for (int pw = 0; pw < kPatch; ++pw) {
            const int y = gh * kPatch + ph;
            const int x = gw * kPatch + pw;
            patch[(c * kPatch + ph) * kPatch + pw] = at(y, x, c);
          }
        }
      }
    }
  }
  (void)kMerge;
  return out;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
