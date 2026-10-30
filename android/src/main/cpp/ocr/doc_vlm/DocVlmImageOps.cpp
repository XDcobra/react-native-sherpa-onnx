#include "DocVlmImageOps.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

int CeilTo(int value, int multiple) {
  if (value <= 0) return multiple;
  return ((value + multiple - 1) / multiple) * multiple;
}

void RequirePositive(int width, int height, const char* what) {
  if (width <= 0 || height <= 0) {
    throw std::invalid_argument(std::string("DocVlmImageOps: ") + what);
  }
}

double Lanczos3(double x) {
  if (x <= -3.0 || x >= 3.0) return 0.0;
  if (x > -1e-7 && x < 1e-7) return 1.0;
  const double pix = x * 3.14159265358979323846;
  const double pix_a = pix / 3.0;
  return (std::sin(pix) / pix) * (std::sin(pix_a) / pix_a);
}

struct AxisCoeffs {
  int ksize = 0;
  std::vector<int> xmin;
  std::vector<int> count;
  std::vector<double> weights;
};

AxisCoeffs Precompute(int in_size, int out_size) {
  const double scale = static_cast<double>(in_size) / static_cast<double>(out_size);
  const double filterscale = scale < 1.0 ? 1.0 : scale;
  const double support = 3.0 * filterscale;
  const int ksize = static_cast<int>(std::ceil(support)) * 2 + 1;
  const double inv = 1.0 / filterscale;

  AxisCoeffs axis;
  axis.ksize = ksize;
  axis.xmin.resize(static_cast<size_t>(out_size));
  axis.count.resize(static_cast<size_t>(out_size));
  axis.weights.assign(static_cast<size_t>(out_size) * static_cast<size_t>(ksize), 0.0);

  for (int xx = 0; xx < out_size; ++xx) {
    const double center = (static_cast<double>(xx) + 0.5) * scale;
    int xmin = static_cast<int>(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    int xmax = static_cast<int>(center + support + 0.5);
    if (xmax > in_size) xmax = in_size;
    const int count = xmax - xmin;
    double* w = axis.weights.data() + static_cast<size_t>(xx) * static_cast<size_t>(ksize);
    double ww = 0.0;
    for (int k = 0; k < count; ++k) {
      const double weight =
          Lanczos3((static_cast<double>(k + xmin) - center + 0.5) * inv);
      w[k] = weight;
      ww += weight;
    }
    if (ww != 0.0) {
      for (int k = 0; k < count; ++k) w[k] /= ww;
    }
    axis.xmin[static_cast<size_t>(xx)] = xmin;
    axis.count[static_cast<size_t>(xx)] = count;
  }
  return axis;
}

uint8_t Clamp8(double v) {
  if (v <= 0.0) return 0;
  if (v >= 255.0) return 255;
  return static_cast<uint8_t>(std::lround(v));
}

void ResizeRgbLanczos(const uint8_t* src, int sw, int sh, uint8_t* dst, int dw, int dh) {
  RequirePositive(sw, sh, "resize source");
  RequirePositive(dw, dh, "resize dest");
  const AxisCoeffs horiz = Precompute(sw, dw);
  const AxisCoeffs vert = Precompute(sh, dh);
  std::vector<uint8_t> tmp(static_cast<size_t>(dw) * static_cast<size_t>(sh) * 3);

  for (int y = 0; y < sh; ++y) {
    for (int x = 0; x < dw; ++x) {
      const int xmin = horiz.xmin[static_cast<size_t>(x)];
      const int n = horiz.count[static_cast<size_t>(x)];
      const double* w =
          horiz.weights.data() + static_cast<size_t>(x) * static_cast<size_t>(horiz.ksize);
      double acc0 = 0.0;
      double acc1 = 0.0;
      double acc2 = 0.0;
      for (int k = 0; k < n; ++k) {
        const uint8_t* p = src + (static_cast<size_t>(y) * static_cast<size_t>(sw) +
                                   static_cast<size_t>(xmin + k)) *
                                      3;
        acc0 += w[k] * static_cast<double>(p[0]);
        acc1 += w[k] * static_cast<double>(p[1]);
        acc2 += w[k] * static_cast<double>(p[2]);
      }
      uint8_t* d = tmp.data() + (static_cast<size_t>(y) * static_cast<size_t>(dw) +
                                  static_cast<size_t>(x)) *
                                     3;
      d[0] = Clamp8(acc0);
      d[1] = Clamp8(acc1);
      d[2] = Clamp8(acc2);
    }
  }

  for (int y = 0; y < dh; ++y) {
    const int ymin = vert.xmin[static_cast<size_t>(y)];
    const int n = vert.count[static_cast<size_t>(y)];
    const double* w =
        vert.weights.data() + static_cast<size_t>(y) * static_cast<size_t>(vert.ksize);
    for (int x = 0; x < dw; ++x) {
      double acc0 = 0.0;
      double acc1 = 0.0;
      double acc2 = 0.0;
      for (int k = 0; k < n; ++k) {
        const uint8_t* p = tmp.data() + (static_cast<size_t>(ymin + k) * static_cast<size_t>(dw) +
                                          static_cast<size_t>(x)) *
                                             3;
        acc0 += w[k] * static_cast<double>(p[0]);
        acc1 += w[k] * static_cast<double>(p[1]);
        acc2 += w[k] * static_cast<double>(p[2]);
      }
      uint8_t* d = dst + (static_cast<size_t>(y) * static_cast<size_t>(dw) +
                          static_cast<size_t>(x)) *
                             3;
      d[0] = Clamp8(acc0);
      d[1] = Clamp8(acc1);
      d[2] = Clamp8(acc2);
    }
  }
}

void WriteTile(const uint8_t* rgb, int tw, int th, int image_index, int tile,
               float rescale, const float mean[3], const float stdev[3],
               std::vector<float>& nchw, std::vector<uint8_t>& mask) {
  const int plane = tile * tile;
  float* base = nchw.data() + static_cast<size_t>(image_index) * 3 * static_cast<size_t>(plane);
  uint8_t* mbase = mask.data() + static_cast<size_t>(image_index) * static_cast<size_t>(plane);
  for (int y = 0; y < tile; ++y) {
    for (int x = 0; x < tile; ++x) {
      const bool valid = y < th && x < tw;
      mbase[y * tile + x] = valid ? 1 : 0;
      for (int c = 0; c < 3; ++c) {
        float v = 0.f;
        if (valid) {
          const float pixel = static_cast<float>(rgb[(y * tw + x) * 3 + c]) * rescale;
          v = (pixel - mean[c]) / stdev[c];
        }
        base[(c * plane) + y * tile + x] = v;
      }
    }
  }
}

}  // namespace

DocVlmSize LongestEdgeSize(int width, int height, int longest_edge) {
  RequirePositive(width, height, "longest-edge source");
  if (longest_edge <= 0) {
    throw std::invalid_argument("DocVlmImageOps: longest edge must be positive");
  }
  const double aspect = static_cast<double>(width) / static_cast<double>(height);
  int out_w = 0;
  int out_h = 0;
  if (width >= height) {
    out_w = longest_edge;
    out_h = static_cast<int>(static_cast<double>(out_w) / aspect);
    if (out_h % 2 != 0) ++out_h;
  } else {
    out_h = longest_edge;
    out_w = static_cast<int>(static_cast<double>(out_h) * aspect);
    if (out_w % 2 != 0) ++out_w;
  }
  if (out_h < 1) out_h = 1;
  if (out_w < 1) out_w = 1;
  return DocVlmSize{out_w, out_h};
}

DocVlmSize VisionEncoderSize(int width, int height, int multiple) {
  RequirePositive(width, height, "vision-encoder source");
  if (multiple <= 0) {
    throw std::invalid_argument("DocVlmImageOps: tile multiple must be positive");
  }
  const double aspect = static_cast<double>(width) / static_cast<double>(height);
  int out_w = width;
  int out_h = height;
  if (width >= height) {
    out_w = CeilTo(width, multiple);
    out_h = static_cast<int>(static_cast<double>(out_w) / aspect);
    out_h = CeilTo(out_h, multiple);
  } else {
    out_h = CeilTo(height, multiple);
    out_w = static_cast<int>(static_cast<double>(out_h) * aspect);
    out_w = CeilTo(out_w, multiple);
  }
  return DocVlmSize{out_w, out_h};
}

DocVlmGrid SplitGrid(int width, int height, int tile) {
  RequirePositive(width, height, "split source");
  if (tile <= 0) {
    throw std::invalid_argument("DocVlmImageOps: tile must be positive");
  }
  DocVlmGrid grid;
  if (width <= tile && height <= tile) {
    grid.rows = 0;
    grid.cols = 0;
    grid.num_images = 1;
    grid.tile_w = width;
    grid.tile_h = height;
    return grid;
  }
  const int rows = (height + tile - 1) / tile;
  const int cols = (width + tile - 1) / tile;
  if (rows > 4 || cols > 4) {
    throw std::invalid_argument("DocVlmImageOps: tile grid exceeds 4x4");
  }
  grid.rows = rows;
  grid.cols = cols;
  grid.num_images = rows * cols + 1;
  grid.tile_h = (height + rows - 1) / rows;
  grid.tile_w = (width + cols - 1) / cols;
  return grid;
}

DocVlmTiles PreprocessRgb(const uint8_t* rgb, int width, int height, int longest_edge,
                          int tile, float rescale_factor, const float mean[3],
                          const float stdev[3]) {
  if (rgb == nullptr) {
    throw std::invalid_argument("DocVlmImageOps: null rgb");
  }
  const DocVlmSize step_a = LongestEdgeSize(width, height, longest_edge);
  std::vector<uint8_t> canvas_a(static_cast<size_t>(step_a.width) * step_a.height * 3);
  ResizeRgbLanczos(rgb, width, height, canvas_a.data(), step_a.width, step_a.height);

  const DocVlmSize step_b = VisionEncoderSize(step_a.width, step_a.height, tile);
  std::vector<uint8_t> canvas_b(static_cast<size_t>(step_b.width) * step_b.height * 3);
  ResizeRgbLanczos(canvas_a.data(), step_a.width, step_a.height, canvas_b.data(),
                   step_b.width, step_b.height);
  canvas_a.clear();
  canvas_a.shrink_to_fit();

  const DocVlmGrid grid = SplitGrid(step_b.width, step_b.height, tile);
  DocVlmTiles out;
  out.rows = grid.rows;
  out.cols = grid.cols;
  out.num_images = grid.num_images;
  out.canvas_width = step_b.width;
  out.canvas_height = step_b.height;
  const size_t plane = static_cast<size_t>(tile) * static_cast<size_t>(tile);
  out.nchw.assign(static_cast<size_t>(grid.num_images) * 3 * plane, 0.f);
  out.mask.assign(static_cast<size_t>(grid.num_images) * plane, 0);

  auto emit = [&](int index, const uint8_t* src, int sw, int sh) {
    WriteTile(src, sw, sh, index, tile, rescale_factor, mean, stdev, out.nchw, out.mask);
  };

  if (grid.rows == 0 && grid.cols == 0) {
    emit(0, canvas_b.data(), step_b.width, step_b.height);
    return out;
  }

  int index = 0;
  for (int r = 0; r < grid.rows; ++r) {
    for (int c = 0; c < grid.cols; ++c) {
      const int x0 = c * grid.tile_w;
      const int y0 = r * grid.tile_h;
      const int x1 = std::min(x0 + grid.tile_w, step_b.width);
      const int y1 = std::min(y0 + grid.tile_h, step_b.height);
      const int cw = x1 - x0;
      const int ch = y1 - y0;
      std::vector<uint8_t> crop(static_cast<size_t>(cw) * static_cast<size_t>(ch) * 3);
      for (int y = 0; y < ch; ++y) {
        std::memcpy(crop.data() + static_cast<size_t>(y) * static_cast<size_t>(cw) * 3,
                    canvas_b.data() + (static_cast<size_t>(y0 + y) * static_cast<size_t>(step_b.width) +
                                       static_cast<size_t>(x0)) *
                                          3,
                    static_cast<size_t>(cw) * 3);
      }
      emit(index, crop.data(), cw, ch);
      ++index;
    }
  }

  std::vector<uint8_t> global(plane * 3);
  ResizeRgbLanczos(canvas_b.data(), step_b.width, step_b.height, global.data(), tile, tile);
  emit(index, global.data(), tile, tile);
  return out;
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
