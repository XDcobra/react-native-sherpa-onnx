#include <gtest/gtest.h>

#include "OcrCrop.h"
#include "OcrGeometry.h"

#include <vector>

using sherpa_onnx::ocr::ClampRect;
using sherpa_onnx::ocr::GridCoordToPixel;
using sherpa_onnx::ocr::GridToPixels;
using sherpa_onnx::ocr::NormToPixels;
using sherpa_onnx::ocr::NormToQuad;
using sherpa_onnx::ocr::OcrGridRect;
using sherpa_onnx::ocr::OcrPixelRect;
using sherpa_onnx::ocr::PixelsToGrid;
using sherpa_onnx::ocr::PixelsToNorm;
using sherpa_onnx::ocr::RectToQuad;
using sherpa_onnx::ocr::TranslateQuad;
using sherpa_onnx::ocr::kOcrGridGranite;
using sherpa_onnx::ocr::kOcrGridPaddle;

TEST(OcrGeometry, GraniteTitleBox) {
  // page_01 title (48,55,452×33) on 900×1200 → loc_27, loc_23, loc_278, loc_37
  OcrPixelRect rect{48, 55, 452, 33};
  const auto grid = PixelsToGrid(rect, 900, 1200, kOcrGridGranite);
  EXPECT_EQ(grid.x1, 27);
  EXPECT_EQ(grid.y1, 23);
  EXPECT_EQ(grid.x2, 278);
  EXPECT_EQ(grid.y2, 37);
}

TEST(OcrGeometry, FullFrameAndClamp) {
  OcrPixelRect full{0, 0, 900, 1200};
  const auto grid = PixelsToGrid(full, 900, 1200, kOcrGridGranite);
  EXPECT_EQ(grid.x1, 0);
  EXPECT_EQ(grid.y1, 0);
  EXPECT_EQ(grid.x2, 500);
  EXPECT_EQ(grid.y2, 500);

  const auto paddle = PixelsToGrid(full, 900, 1200, kOcrGridPaddle);
  EXPECT_EQ(paddle.x2, 1000);
  EXPECT_EQ(paddle.y2, 1000);

  const auto clamped = ClampRect({-10, -4, 2000, 50}, 100, 80);
  EXPECT_EQ(clamped.x, 0);
  EXPECT_EQ(clamped.y, 0);
  EXPECT_EQ(clamped.width, 100);
  EXPECT_LE(clamped.height, 80);

  EXPECT_EQ(GridCoordToPixel(0, 200, kOcrGridPaddle), 0);
  EXPECT_EQ(GridCoordToPixel(1000, 200, kOcrGridPaddle), 200);
  EXPECT_EQ(GridCoordToPixel(500, 200, kOcrGridPaddle), 100);
}

TEST(OcrGeometry, RoundTripAndTranslate) {
  OcrPixelRect rect{10, 20, 40, 30};
  const auto grid = PixelsToGrid(rect, 200, 100, kOcrGridPaddle);
  const auto back = GridToPixels(grid, 200, 100, kOcrGridPaddle);
  EXPECT_NEAR(back.x, rect.x, 2);
  EXPECT_NEAR(back.y, rect.y, 2);

  const auto norm = PixelsToNorm(rect, 200, 100);
  const auto from_norm = NormToPixels(norm, 200, 100);
  EXPECT_EQ(from_norm.x, 10);
  EXPECT_EQ(from_norm.y, 20);
  EXPECT_EQ(from_norm.width, 40);
  EXPECT_EQ(from_norm.height, 30);

  const auto quad = RectToQuad(rect);
  const auto moved = TranslateQuad(quad, 5.f, 7.f);
  EXPECT_FLOAT_EQ(moved.xy[0], 15.f);
  EXPECT_FLOAT_EQ(moved.xy[1], 27.f);
  EXPECT_FLOAT_EQ(moved.xy[4], 55.f);
  EXPECT_FLOAT_EQ(moved.xy[5], 57.f);
}

TEST(OcrGeometry, DocTagsHelloQuadViaSharedGrid) {
  OcrGridRect locs{0, 0, 250, 250};
  const auto rect = GridToPixels(locs, 1000, 240, kOcrGridGranite);
  const auto quad = RectToQuad(rect);
  EXPECT_EQ(rect.x, 0);
  EXPECT_EQ(rect.y, 0);
  EXPECT_EQ(rect.width, 500);
  EXPECT_EQ(rect.height, 120);
  EXPECT_FLOAT_EQ(quad.xy[2], 500.f);
  EXPECT_FLOAT_EQ(quad.xy[5], 120.f);

  // loc_10 / 500 * 240 = 4.8 → half-up 5 (TitleMarkdown fixture).
  EXPECT_EQ(GridCoordToPixel(10, 240, kOcrGridGranite), 5);
  EXPECT_EQ(GridCoordToPixel(10, 1000, kOcrGridGranite), 20);
}

TEST(OcrGeometry, NemotronNormStaysFloat) {
  sherpa_onnx::ocr::OcrNormRect box{0.f, 0.f, 0.9961f, 0.9938f};
  const auto quad = NormToQuad(box, 100, 50);
  EXPECT_NEAR(quad.xy[4], 99.61f, 0.01f);
  EXPECT_NEAR(quad.xy[5], 49.69f, 0.01f);
}

TEST(OcrCrop, CopiesPixelsAndTranslatesQuadsBack) {
  constexpr int kW = 8;
  constexpr int kH = 6;
  std::vector<uint8_t> rgb(static_cast<size_t>(kW) * kH * 3, 0);
  rgb[(2 * kW + 3) * 3 + 0] = 11;
  rgb[(2 * kW + 3) * 3 + 1] = 22;
  rgb[(2 * kW + 3) * 3 + 2] = 33;
  sherpa_onnx::ocr::OcrFrameView frame;
  frame.rgb = rgb.data();
  frame.width = kW;
  frame.height = kH;
  sherpa_onnx::ocr::OcrCroppedFrame cropped(frame, OcrPixelRect{2, 1, 4, 3});
  EXPECT_EQ(cropped.view().width, 4);
  EXPECT_EQ(cropped.view().height, 3);
  EXPECT_EQ(cropped.dx(), 2);
  EXPECT_EQ(cropped.dy(), 1);
  const uint8_t* crop_rgb = cropped.view().rgb;
  ASSERT_NE(crop_rgb, nullptr);
  EXPECT_EQ(crop_rgb[(1 * 4 + 1) * 3 + 0], 11);
  EXPECT_EQ(crop_rgb[(1 * 4 + 1) * 3 + 1], 22);
  EXPECT_EQ(crop_rgb[(1 * 4 + 1) * 3 + 2], 33);

  sherpa_onnx::ocr::OcrResult result;
  sherpa_onnx::ocr::OcrSpan span;
  span.quad = RectToQuad(OcrPixelRect{1, 1, 2, 1});
  result.spans.push_back(span);
  cropped.TranslateResult(result);
  EXPECT_FLOAT_EQ(result.spans[0].quad.xy[0], 3.f);
  EXPECT_FLOAT_EQ(result.spans[0].quad.xy[1], 2.f);
  EXPECT_FLOAT_EQ(result.spans[0].quad.xy[4], 5.f);
  EXPECT_FLOAT_EQ(result.spans[0].quad.xy[5], 3.f);
}
