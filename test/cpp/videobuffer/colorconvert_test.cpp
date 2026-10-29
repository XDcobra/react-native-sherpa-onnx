#include "core/ColorConvert.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include <gtest/gtest.h>

using sherpa_onnx::video::AlignedBuffer;
using sherpa_onnx::video::ColorConvert;
using sherpa_onnx::video::ColorMatrix;
using sherpa_onnx::video::ColorRange;
using sherpa_onnx::video::Nv12View;
using sherpa_onnx::video::PackedPlane;
using sherpa_onnx::video::VideoFrameView;
using sherpa_onnx::video::VideoPixelFormat;
using sherpa_onnx::video::VideoTransform;

namespace {

struct Nv12Image {
  int w = 0;
  int h = 0;
  std::vector<uint8_t> y;
  std::vector<uint8_t> uv;
  Nv12View view() const {
    Nv12View v;
    v.width = w;
    v.height = h;
    v.y.data = y.data();
    v.y.stride = w;
    v.uv.data = uv.data();
    v.uv.stride = w;
    return v;
  }
};

Nv12Image MakeNv12(int w, int h, uint8_t yv, uint8_t u, uint8_t v) {
  Nv12Image img;
  img.w = w;
  img.h = h;
  img.y.assign(static_cast<size_t>(w * h), yv);
  img.uv.resize(static_cast<size_t>(w * ((h + 1) / 2)));
  for (size_t i = 0; i + 1 < img.uv.size(); i += 2) {
    img.uv[i] = u;
    img.uv[i + 1] = v;
  }
  return img;
}

// ITU integer YUV→RGB used by libyuv (8-bit). Within ±2 of NV12ToRAW.
void YuvToRgbRef(int y, int u, int v, ColorMatrix m, ColorRange range, int* r,
                 int* g, int* b) {
  int C = y;
  int D = u - 128;
  int E = v - 128;
  int R, G, B;
  if (range == ColorRange::Limited) {
    C = y - 16;
    if (m == ColorMatrix::Bt709) {
      R = (298 * C + 459 * E + 128) >> 8;
      G = (298 * C - 55 * D - 136 * E + 128) >> 8;
      B = (298 * C + 541 * D + 128) >> 8;
    } else if (m == ColorMatrix::Bt2020) {
      R = (298 * C + 459 * E + 128) >> 8;
      G = (298 * C - 47 * D - 176 * E + 128) >> 8;
      B = (298 * C + 545 * D + 128) >> 8;
    } else {
      R = (298 * C + 409 * E + 128) >> 8;
      G = (298 * C - 100 * D - 208 * E + 128) >> 8;
      B = (298 * C + 516 * D + 128) >> 8;
    }
  } else {
    if (m == ColorMatrix::Bt709) {
      R = y + ((459 * E + 128) >> 8);
      G = y + ((-55 * D - 136 * E + 128) >> 8);
      B = y + ((541 * D + 128) >> 8);
    } else if (m == ColorMatrix::Bt2020) {
      R = y + ((459 * E + 128) >> 8);
      G = y + ((-47 * D - 176 * E + 128) >> 8);
      B = y + ((545 * D + 128) >> 8);
    } else {
      R = y + ((359 * E + 128) >> 8);
      G = y + ((-88 * D - 183 * E + 128) >> 8);
      B = y + ((454 * D + 128) >> 8);
    }
  }
  auto clamp = [](int x) { return std::min(255, std::max(0, x)); };
  *r = clamp(R);
  *g = clamp(G);
  *b = clamp(B);
}

}  // namespace

TEST(ColorConvert, Nv12ToRgb24NeutralGrayLimited601) {
  auto img = MakeNv12(16, 16, 128, 128, 128);
  std::vector<uint8_t> rgb(16 * 16 * 3);
  PackedPlane dst;
  dst.data = rgb.data();
  dst.stride = 16 * 3;
  auto st = ColorConvert::Nv12ToRgb24(img.view(), &dst, ColorMatrix::Bt601,
                                      ColorRange::Limited, true);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  int rr, gg, bb;
  YuvToRgbRef(128, 128, 128, ColorMatrix::Bt601, ColorRange::Limited, &rr, &gg,
              &bb);
  EXPECT_NEAR(rgb[0], rr, 2);
  EXPECT_NEAR(rgb[1], gg, 2);
  EXPECT_NEAR(rgb[2], bb, 2);
}

TEST(ColorConvert, Nv12ToRgb24MatricesWithinTwo) {
  // Goldens: libyuv 63e54f73 NV12→RAW equivalent for YUV(81,90,240).
  struct Case {
    ColorMatrix matrix;
    ColorRange range;
    int r;
    int g;
    int b;
  };
  const Case cases[] = {
      {ColorMatrix::Bt601, ColorRange::Limited, 254, 0, 0},
      {ColorMatrix::Bt601, ColorRange::Full, 238, 14, 14},
      {ColorMatrix::Bt709, ColorRange::Limited, 255, 24, 0},
      {ColorMatrix::Bt709, ColorRange::Full, 255, 36, 10},
      {ColorMatrix::Bt2020, ColorRange::Limited, 255, 9, 0},
      {ColorMatrix::Bt2020, ColorRange::Full, 245, 23, 10},
  };
  auto img = MakeNv12(8, 8, 81, 90, 240);
  for (const auto& c : cases) {
      std::vector<uint8_t> rgb(8 * 8 * 3);
      PackedPlane dst;
      dst.data = rgb.data();
      dst.stride = 8 * 3;
      auto st = ColorConvert::Nv12ToRgb24(img.view(), &dst, c.matrix, c.range, true);
      ASSERT_TRUE(st.ok) << st.errorMessage;
      EXPECT_NEAR(rgb[0], c.r, 2) << ColorConvert::MatrixName(c.matrix) << " R";
      EXPECT_NEAR(rgb[1], c.g, 2) << ColorConvert::MatrixName(c.matrix) << " G";
      EXPECT_NEAR(rgb[2], c.b, 2) << ColorConvert::MatrixName(c.matrix) << " B";
  }
}

TEST(ColorConvert, Gray8EqualsYPlane) {
  auto img = MakeNv12(12, 10, 0, 128, 128);
  for (int i = 0; i < 12 * 10; ++i) {
    img.y[static_cast<size_t>(i)] = static_cast<uint8_t>(i * 3);
  }
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform id;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Gray8, id, 0,
                                  true, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  ASSERT_EQ(view.width, 12);
  ASSERT_EQ(view.height, 10);
  ASSERT_EQ(view.stride[0], 12);
  EXPECT_EQ(0, std::memcmp(view.plane[0], img.y.data(), img.y.size()));
}

TEST(ColorConvert, PackedRgbStride) {
  auto img = MakeNv12(10, 8, 16, 128, 128);
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform id;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Rgb24, id, 0,
                                  true, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.stride[0], 10 * 3);
}

TEST(ColorConvert, Rotate90SwapsDims) {
  auto img = MakeNv12(32, 16, 200, 128, 128);
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform t;
  t.rotationDegrees = 90;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Gray8, t, 0,
                                  true, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.width, 16);
  EXPECT_EQ(view.height, 32);
}

TEST(ColorConvert, Rotate180KeepsDims) {
  auto img = MakeNv12(16, 16, 40, 128, 128);
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform t;
  t.rotationDegrees = 180;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Gray8, t, 0,
                                  true, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.width, 16);
  EXPECT_EQ(view.height, 16);
}

TEST(ColorConvert, Rotate270SwapsDims) {
  auto img = MakeNv12(20, 10, 90, 128, 128);
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform t;
  t.rotationDegrees = 270;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Gray8, t, 0,
                                  true, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.width, 10);
  EXPECT_EQ(view.height, 20);
}

TEST(ColorConvert, MirrorHorizontal) {
  auto img = MakeNv12(8, 4, 0, 128, 128);
  img.y[0] = 10;
  img.y[7] = 250;
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform t;
  t.mirrorHorizontal = true;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Gray8, t, 0,
                                  true, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.plane[0][0], 250);
  EXPECT_EQ(view.plane[0][7], 10);
}

TEST(ColorConvert, ScaleMaxSide) {
  auto img = MakeNv12(64, 32, 80, 128, 128);
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform id;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Nv12, id, 32,
                                  false, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.width, 32);
  EXPECT_EQ(view.height, 16);
}

TEST(ColorConvert, AlignedRgbStrideNotPacked) {
  auto img = MakeNv12(10, 8, 16, 128, 128);
  AlignedBuffer storage;
  VideoFrameView view;
  VideoTransform id;
  auto st = ColorConvert::Convert(img.view(), VideoPixelFormat::Rgb24, id, 0,
                                  false, &storage, &view);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(view.stride[0] % 64, 0);
  EXPECT_GE(view.stride[0], 10 * 3);
}
