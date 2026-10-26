#include "NemotronParseImageOps.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {
namespace {

constexpr int kMaxH = 2048;
constexpr int kMaxW = 1664;
constexpr int kPatch = 16;
constexpr int kPadW = 64;
constexpr float kMean[3] = {0.48145466f, 0.4578275f, 0.40821073f};
constexpr float kStd[3] = {0.26862954f, 0.26130258f, 0.27577711f};

void RequirePositive(int w, int h, const char* what) {
  if (w <= 0 || h <= 0) {
    throw std::invalid_argument(std::string("NemotronParseImageOps: ") + what);
  }
}

void ResizeBilinear(const uint8_t* src, int sw, int sh, uint8_t* dst, int dw, int dh) {
  if (sw == dw && sh == dh) {
    std::copy(src, src + static_cast<size_t>(sw) * static_cast<size_t>(sh) * 3, dst);
    return;
  }
  const float x_scale = static_cast<float>(sw) / static_cast<float>(dw);
  const float y_scale = static_cast<float>(sh) / static_cast<float>(dh);
  for (int y = 0; y < dh; ++y) {
    const float fy = (static_cast<float>(y) + 0.5f) * y_scale - 0.5f;
    const int y0 = std::max(0, static_cast<int>(std::floor(fy)));
    const int y1 = std::min(sh - 1, y0 + 1);
    const float wy = fy - static_cast<float>(y0);
    for (int x = 0; x < dw; ++x) {
      const float fx = (static_cast<float>(x) + 0.5f) * x_scale - 0.5f;
      const int x0 = std::max(0, static_cast<int>(std::floor(fx)));
      const int x1 = std::min(sw - 1, x0 + 1);
      const float wx = fx - static_cast<float>(x0);
      for (int c = 0; c < 3; ++c) {
        const float v00 = src[(static_cast<size_t>(y0) * sw + x0) * 3 + c];
        const float v10 = src[(static_cast<size_t>(y0) * sw + x1) * 3 + c];
        const float v01 = src[(static_cast<size_t>(y1) * sw + x0) * 3 + c];
        const float v11 = src[(static_cast<size_t>(y1) * sw + x1) * 3 + c];
        const float v0 = v00 + (v10 - v00) * wx;
        const float v1 = v01 + (v11 - v01) * wx;
        dst[(static_cast<size_t>(y) * dw + x) * 3 + c] =
            static_cast<uint8_t>(std::lround(v0 + (v1 - v0) * wy));
      }
    }
  }
}

}  // namespace

NemotronParsePatches PreprocessRgb(const uint8_t* rgb, int width, int height) {
  RequirePositive(width, height, "source size");
  if (rgb == nullptr) {
    throw std::invalid_argument("NemotronParseImageOps: null rgb");
  }

  int rw = width;
  int rh = height;
  const float aspect = static_cast<float>(width) / static_cast<float>(height);
  if (rh > kMaxH) {
    rh = kMaxH;
    rw = static_cast<int>(static_cast<float>(rh) * aspect);
  }
  if (rw > kMaxW) {
    rw = kMaxW;
    rh = static_cast<int>(static_cast<float>(rw) / aspect);
  }
  if (rw < 1) rw = 1;
  if (rh < 1) rh = 1;

  std::vector<uint8_t> resized(static_cast<size_t>(rw) * static_cast<size_t>(rh) * 3);
  ResizeBilinear(rgb, width, height, resized.data(), rw, rh);

  const int content_h = rh;
  const int content_w = rw;
  const int pad_h = ((rh + kPatch - 1) / kPatch) * kPatch;
  const int pad_w = ((rw + kPadW - 1) / kPadW) * kPadW;
  std::vector<uint8_t> padded(static_cast<size_t>(pad_h) * static_cast<size_t>(pad_w) * 3, 255);
  for (int y = 0; y < rh; ++y) {
    std::copy(resized.data() + static_cast<size_t>(y) * rw * 3,
              resized.data() + static_cast<size_t>(y + 1) * rw * 3,
              padded.data() + static_cast<size_t>(y) * pad_w * 3);
  }

  const int rows = pad_h / kPatch;
  const int cols = pad_w / kPatch;
  NemotronParsePatches out;
  out.content_h = content_h;
  out.content_w = content_w;
  out.image_h = pad_h;
  out.image_w = pad_w;
  out.rows = rows;
  out.cols = cols;
  out.patches.assign(static_cast<size_t>(rows) * static_cast<size_t>(cols) * 768, 0.f);

  for (int r = 0; r < rows; ++r) {
    for (int c = 0; c < cols; ++c) {
      float* dest = out.patches.data() + (static_cast<size_t>(r) * cols + c) * 768;
      for (int ch = 0; ch < 3; ++ch) {
        for (int py = 0; py < kPatch; ++py) {
          for (int px = 0; px < kPatch; ++px) {
            const int y = r * kPatch + py;
            const int x = c * kPatch + px;
            const float pix =
                padded[(static_cast<size_t>(y) * pad_w + x) * 3 + ch] / 255.f;
            dest[(ch * kPatch + py) * kPatch + px] = (pix - kMean[ch]) / kStd[ch];
          }
        }
      }
    }
  }
  return out;
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
