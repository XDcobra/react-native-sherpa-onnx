#include "NemotronParseNavit.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {
namespace {

constexpr int kPatch = 16;
constexpr int kGrid = 128;
constexpr int kWidth = 1152;

float SampleBilinear(const float* src, int sh, int sw, int c, float y, float x) {
  const float yc = std::min(static_cast<float>(sh - 1), std::max(0.f, y));
  const float xc = std::min(static_cast<float>(sw - 1), std::max(0.f, x));
  const int y0 = static_cast<int>(std::floor(yc));
  const int x0 = static_cast<int>(std::floor(xc));
  const int y1 = std::min(sh - 1, y0 + 1);
  const int x1 = std::min(sw - 1, x0 + 1);
  const float wy = yc - static_cast<float>(y0);
  const float wx = xc - static_cast<float>(x0);
  const size_t plane = static_cast<size_t>(c) * sh * sw;
  const float v00 = src[plane + static_cast<size_t>(y0) * sw + x0];
  const float v10 = src[plane + static_cast<size_t>(y0) * sw + x1];
  const float v01 = src[plane + static_cast<size_t>(y1) * sw + x0];
  const float v11 = src[plane + static_cast<size_t>(y1) * sw + x1];
  return (v00 * (1.f - wx) + v10 * wx) * (1.f - wy) + (v01 * (1.f - wx) + v11 * wx) * wy;
}

/** PyTorch F.interpolate bilinear + antialias + align_corners=false. */
void ResizeNchw(const std::vector<float>& src, int sh, int sw, std::vector<float>& dst,
                int dh, int dw) {
  dst.assign(static_cast<size_t>(kWidth) * dh * dw, 0.f);
  const float y_scale = static_cast<float>(sh) / static_cast<float>(dh);
  const float x_scale = static_cast<float>(sw) / static_cast<float>(dw);
  const float y_support = y_scale > 1.f ? y_scale : 1.f;
  const float x_support = x_scale > 1.f ? x_scale : 1.f;
  auto kernel = [](float t) {
    t = std::fabs(t);
    return t < 1.f ? 1.f - t : 0.f;
  };
  for (int c = 0; c < kWidth; ++c) {
    const float* plane = src.data() + static_cast<size_t>(c) * sh * sw;
    float* out = dst.data() + static_cast<size_t>(c) * dh * dw;
    for (int y = 0; y < dh; ++y) {
      const float cy = (static_cast<float>(y) + 0.5f) * y_scale - 0.5f;
      const int y0 = std::max(0, static_cast<int>(std::ceil(cy - y_support)));
      const int y1 = std::min(sh - 1, static_cast<int>(std::floor(cy + y_support)));
      for (int x = 0; x < dw; ++x) {
        const float cx = (static_cast<float>(x) + 0.5f) * x_scale - 0.5f;
        const int x0 = std::max(0, static_cast<int>(std::ceil(cx - x_support)));
        const int x1 = std::min(sw - 1, static_cast<int>(std::floor(cx + x_support)));
        double acc = 0.0;
        double wsum = 0.0;
        for (int yy = y0; yy <= y1; ++yy) {
          const float wy = kernel((static_cast<float>(yy) - cy) / y_support);
          if (wy == 0.f) continue;
          for (int xx = x0; xx <= x1; ++xx) {
            const float wx = kernel((static_cast<float>(xx) - cx) / x_support);
            if (wx == 0.f) continue;
            const float w = wy * wx;
            acc += static_cast<double>(plane[static_cast<size_t>(yy) * sw + xx]) * w;
            wsum += w;
          }
        }
        out[static_cast<size_t>(y) * dw + x] =
            wsum > 0.0 ? static_cast<float>(acc / wsum) : 0.f;
      }
    }
  }
}

void AdaptiveAvgPool(const std::vector<float>& src, int sh, int sw, std::vector<float>& dst,
                     int dh, int dw) {
  dst.assign(static_cast<size_t>(kWidth) * dh * dw, 0.f);
  for (int c = 0; c < kWidth; ++c) {
    for (int y = 0; y < dh; ++y) {
      const int y0 = y * sh / dh;
      const int y1 = (y + 1) * sh / dh;
      for (int x = 0; x < dw; ++x) {
        const int x0 = x * sw / dw;
        const int x1 = (x + 1) * sw / dw;
        double sum = 0.0;
        int n = 0;
        for (int yy = y0; yy < std::max(y1, y0 + 1); ++yy) {
          for (int xx = x0; xx < std::max(x1, x0 + 1); ++xx) {
            sum += src[static_cast<size_t>(c) * sh * sw + static_cast<size_t>(yy) * sw + xx];
            ++n;
          }
        }
        dst[static_cast<size_t>(c) * dh * dw + static_cast<size_t>(y) * dw + x] =
            static_cast<float>(sum / std::max(1, n));
      }
    }
  }
}

}  // namespace

std::vector<float> AddNavitPositions(const std::vector<float>& patches,
                                     const std::vector<float>& pos_embed, int image_h,
                                     int image_w, int content_h, int content_w) {
  if (image_h <= 0 || image_w <= 0 || image_h % kPatch || image_w % kPatch) {
    throw std::runtime_error("NemotronParseNavit: image size is not patch-aligned");
  }
  if (content_h <= 0 || content_w <= 0 || content_h > image_h || content_w > image_w) {
    throw std::runtime_error("NemotronParseNavit: invalid content size");
  }
  const int rows = image_h / kPatch;
  const int cols = image_w / kPatch;
  const size_t n = static_cast<size_t>(rows) * static_cast<size_t>(cols);
  if (patches.size() != n * kWidth) {
    throw std::runtime_error("NemotronParseNavit: patch count mismatch");
  }
  if (pos_embed.size() != static_cast<size_t>(kGrid) * kGrid * kWidth) {
    throw std::runtime_error("NemotronParseNavit: pos_embed size mismatch");
  }

  // pos_embed [16384, 1152] → NCHW [1152, 128, 128]
  std::vector<float> grid(static_cast<size_t>(kWidth) * kGrid * kGrid);
  for (int r = 0; r < kGrid; ++r) {
    for (int c = 0; c < kGrid; ++c) {
      const float* src = pos_embed.data() + (static_cast<size_t>(r) * kGrid + c) * kWidth;
      for (int ch = 0; ch < kWidth; ++ch) {
        grid[static_cast<size_t>(ch) * kGrid * kGrid + static_cast<size_t>(r) * kGrid + c] =
            src[ch];
      }
    }
  }

  const int content_rows = (content_h + kPatch - 1) / kPatch;
  const int content_cols = (content_w + kPatch - 1) / kPatch;
  std::vector<float> page;
  if (std::min(content_rows, content_cols) == 1) {
    AdaptiveAvgPool(grid, kGrid, kGrid, page, content_rows, content_cols);
  } else {
    ResizeNchw(grid, kGrid, kGrid, page, content_rows, content_cols);
  }

  std::vector<float> positioned(n * kWidth);
  for (int r = 0; r < rows; ++r) {
    const float row_start = static_cast<float>(r) * kPatch;
    const float row_ext =
        std::min(static_cast<float>(kPatch), std::max(0.f, static_cast<float>(content_h) - row_start));
    float ny = (row_start + 0.5f * row_ext);
    if (ny > static_cast<float>(content_h)) ny = static_cast<float>(content_h);
    ny /= static_cast<float>(content_h);
    for (int c = 0; c < cols; ++c) {
      const float col_start = static_cast<float>(c) * kPatch;
      const float col_ext =
          std::min(static_cast<float>(kPatch), std::max(0.f, static_cast<float>(content_w) - col_start));
      float nx = (col_start + 0.5f * col_ext);
      if (nx > static_cast<float>(content_w)) nx = static_cast<float>(content_w);
      nx /= static_cast<float>(content_w);
      // align_corners=false grid_sample
      const float gx = 2.f * nx - 1.f;
      const float gy = 2.f * ny - 1.f;
      const float sx = ((gx + 1.f) * static_cast<float>(content_cols) - 1.f) * 0.5f;
      const float sy = ((gy + 1.f) * static_cast<float>(content_rows) - 1.f) * 0.5f;
      float* dest = positioned.data() + (static_cast<size_t>(r) * cols + c) * kWidth;
      const float* patch = patches.data() + (static_cast<size_t>(r) * cols + c) * kWidth;
      for (int ch = 0; ch < kWidth; ++ch) {
        dest[ch] = patch[ch] + SampleBilinear(page.data(), content_rows, content_cols, ch, sy, sx);
      }
    }
  }
  return positioned;
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
