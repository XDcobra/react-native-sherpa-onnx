/**
 * Pixel ↔ family-grid conversions. Public API never exposes family grids.
 */
#pragma once

#include "OcrInstruction.h"
#include "OcrTypes.h"

namespace sherpa_onnx {
namespace ocr {

inline constexpr int kOcrGridGranite = 500;
inline constexpr int kOcrGridPaddle = 1000;

struct OcrGridRect {
  int x1 = 0;
  int y1 = 0;
  int x2 = 0;
  int y2 = 0;
};

/** Integer grid (Granite 0–500, Paddle 0–1000). Half-up, clamped. */
OcrGridRect PixelsToGrid(const OcrPixelRect& rect, int frame_w, int frame_h,
                         int grid);

OcrPixelRect GridToPixels(const OcrGridRect& grid_rect, int frame_w,
                          int frame_h, int grid);

/** Single axis: grid loc → pixel, half-up, clamped to [0, extent]. */
int GridCoordToPixel(int loc, int extent, int grid);

/** Nemotron normalized 0–1 box. */
struct OcrNormRect {
  float x0 = 0.f;
  float y0 = 0.f;
  float x1 = 0.f;
  float y1 = 0.f;
};

OcrNormRect PixelsToNorm(const OcrPixelRect& rect, int frame_w, int frame_h);
OcrPixelRect NormToPixels(const OcrNormRect& norm, int frame_w, int frame_h);
/** Nemotron 1.0-grid boxes stay float; crop/region uses NormToPixels. */
OcrQuad NormToQuad(const OcrNormRect& norm, int frame_w, int frame_h);

OcrQuad RectToQuad(const OcrPixelRect& rect);
OcrPixelRect ClampRect(const OcrPixelRect& rect, int frame_w, int frame_h);
OcrQuad TranslateQuad(const OcrQuad& quad, float dx, float dy);
OcrPixelRect TranslateRect(const OcrPixelRect& rect, int dx, int dy);

}  // namespace ocr
}  // namespace sherpa_onnx
