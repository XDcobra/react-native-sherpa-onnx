#include "OcrGeometry.h"

#include <algorithm>
#include <cmath>

namespace sherpa_onnx {
namespace ocr {
namespace {

int RoundHalfUp(double value) {
  return static_cast<int>(std::floor(value + 0.5));
}

int ClampInt(int value, int lo, int hi) {
  return std::max(lo, std::min(hi, value));
}

int ToGrid(int value, int extent, int grid) {
  if (extent <= 0) return 0;
  const int loc = RoundHalfUp(static_cast<double>(value) / extent * grid);
  return ClampInt(loc, 0, grid);
}

int FromGrid(int loc, int extent, int grid) {
  if (grid <= 0) return 0;
  const int clamped = ClampInt(loc, 0, grid);
  return RoundHalfUp(static_cast<double>(clamped) / grid * extent);
}

}  // namespace

OcrGridRect PixelsToGrid(const OcrPixelRect& rect, int frame_w, int frame_h,
                         int grid) {
  OcrGridRect out;
  out.x1 = ToGrid(rect.x, frame_w, grid);
  out.y1 = ToGrid(rect.y, frame_h, grid);
  out.x2 = ToGrid(rect.x + rect.width, frame_w, grid);
  out.y2 = ToGrid(rect.y + rect.height, frame_h, grid);
  if (out.x2 <= out.x1) out.x2 = std::min(grid, out.x1 + 1);
  if (out.y2 <= out.y1) out.y2 = std::min(grid, out.y1 + 1);
  return out;
}

int GridCoordToPixel(int loc, int extent, int grid) {
  return FromGrid(loc, extent, grid);
}

OcrPixelRect GridToPixels(const OcrGridRect& grid_rect, int frame_w,
                          int frame_h, int grid) {
  OcrPixelRect out;
  const int x1 = FromGrid(grid_rect.x1, frame_w, grid);
  const int y1 = FromGrid(grid_rect.y1, frame_h, grid);
  const int x2 = FromGrid(grid_rect.x2, frame_w, grid);
  const int y2 = FromGrid(grid_rect.y2, frame_h, grid);
  out.x = std::min(x1, x2);
  out.y = std::min(y1, y2);
  out.width = std::max(1, std::abs(x2 - x1));
  out.height = std::max(1, std::abs(y2 - y1));
  return out;
}

OcrNormRect PixelsToNorm(const OcrPixelRect& rect, int frame_w, int frame_h) {
  OcrNormRect out;
  const float w = frame_w > 0 ? static_cast<float>(frame_w) : 1.f;
  const float h = frame_h > 0 ? static_cast<float>(frame_h) : 1.f;
  out.x0 = static_cast<float>(rect.x) / w;
  out.y0 = static_cast<float>(rect.y) / h;
  out.x1 = static_cast<float>(rect.x + rect.width) / w;
  out.y1 = static_cast<float>(rect.y + rect.height) / h;
  return out;
}

OcrPixelRect NormToPixels(const OcrNormRect& norm, int frame_w, int frame_h) {
  OcrPixelRect out;
  const float x0 = std::min(norm.x0, norm.x1);
  const float y0 = std::min(norm.y0, norm.y1);
  const float x1 = std::max(norm.x0, norm.x1);
  const float y1 = std::max(norm.y0, norm.y1);
  out.x = RoundHalfUp(static_cast<double>(x0) * frame_w);
  out.y = RoundHalfUp(static_cast<double>(y0) * frame_h);
  const int x2 = RoundHalfUp(static_cast<double>(x1) * frame_w);
  const int y2 = RoundHalfUp(static_cast<double>(y1) * frame_h);
  out.width = std::max(1, x2 - out.x);
  out.height = std::max(1, y2 - out.y);
  return out;
}

OcrQuad NormToQuad(const OcrNormRect& norm, int frame_w, int frame_h) {
  const float w = frame_w > 0 ? static_cast<float>(frame_w) : 1.f;
  const float h = frame_h > 0 ? static_cast<float>(frame_h) : 1.f;
  const float x0 = std::min(norm.x0, norm.x1) * w;
  const float y0 = std::min(norm.y0, norm.y1) * h;
  const float x1 = std::max(norm.x0, norm.x1) * w;
  const float y1 = std::max(norm.y0, norm.y1) * h;
  OcrQuad q;
  q.xy[0] = x0;
  q.xy[1] = y0;
  q.xy[2] = x1;
  q.xy[3] = y0;
  q.xy[4] = x1;
  q.xy[5] = y1;
  q.xy[6] = x0;
  q.xy[7] = y1;
  return q;
}

OcrQuad RectToQuad(const OcrPixelRect& rect) {
  OcrQuad q;
  const float x0 = static_cast<float>(rect.x);
  const float y0 = static_cast<float>(rect.y);
  const float x1 = static_cast<float>(rect.x + rect.width);
  const float y1 = static_cast<float>(rect.y + rect.height);
  q.xy[0] = x0;
  q.xy[1] = y0;
  q.xy[2] = x1;
  q.xy[3] = y0;
  q.xy[4] = x1;
  q.xy[5] = y1;
  q.xy[6] = x0;
  q.xy[7] = y1;
  return q;
}

OcrPixelRect ClampRect(const OcrPixelRect& rect, int frame_w, int frame_h) {
  OcrPixelRect out = rect;
  out.x = std::max(0, rect.x);
  out.y = std::max(0, rect.y);
  const int max_w = std::max(1, frame_w - out.x);
  const int max_h = std::max(1, frame_h - out.y);
  out.width = std::max(1, std::min(rect.width, max_w));
  out.height = std::max(1, std::min(rect.height, max_h));
  return out;
}

OcrQuad TranslateQuad(const OcrQuad& quad, float dx, float dy) {
  OcrQuad out = quad;
  for (int i = 0; i < 4; ++i) {
    out.xy[i * 2] += dx;
    out.xy[i * 2 + 1] += dy;
  }
  return out;
}

OcrPixelRect TranslateRect(const OcrPixelRect& rect, int dx, int dy) {
  OcrPixelRect out = rect;
  out.x += dx;
  out.y += dy;
  return out;
}

}  // namespace ocr
}  // namespace sherpa_onnx
