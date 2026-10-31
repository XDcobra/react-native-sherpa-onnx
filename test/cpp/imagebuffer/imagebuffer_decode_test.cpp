#include "decode/ImageDecoder.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <vector>

using namespace sherpa_onnx::image;
using sherpa_onnx::image::testutil::FixturePath;
using sherpa_onnx::image::testutil::ReadFileBytes;

TEST(ImageBufferDecode, Decode_DetectsJpegPngWebp) {
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  const auto png = ReadFileBytes(FixturePath("solid_blue_64x48.png"));
  const auto webp = ReadFileBytes(FixturePath("solid_red_64x48.webp"));
  ASSERT_FALSE(jpeg.empty());
  ASSERT_FALSE(png.empty());
  ASSERT_FALSE(webp.empty());

  EXPECT_EQ(ImageDecoder::DetectFormat(jpeg.data(), jpeg.size()), DecodeFormat::Jpeg);
  EXPECT_EQ(ImageDecoder::DetectFormat(png.data(), png.size()), DecodeFormat::Png);
  EXPECT_EQ(ImageDecoder::DetectFormat(webp.data(), webp.size()), DecodeFormat::Webp);
}

TEST(ImageBufferDecode, Decode_UnsupportedHeic_ReturnsFormatError) {
  // Minimal ISO BMFF ftyp/heic brand (not a valid image; sniff + reject).
  std::vector<uint8_t> heic(32, 0);
  heic[0] = 0;
  heic[1] = 0;
  heic[2] = 0;
  heic[3] = 0x18;
  heic[4] = 'f';
  heic[5] = 't';
  heic[6] = 'y';
  heic[7] = 'p';
  heic[8] = 'h';
  heic[9] = 'e';
  heic[10] = 'i';
  heic[11] = 'c';

  EXPECT_EQ(ImageDecoder::DetectFormat(heic.data(), heic.size()), DecodeFormat::Heic);

  const auto result = ImageDecoder::DecodeBytes(heic.data(), heic.size());
  EXPECT_FALSE(result.ok);
  EXPECT_EQ(result.errorCode, "ERR_IMAGE_FORMAT_UNSUPPORTED");
  EXPECT_EQ(result.format, DecodeFormat::Heic);
}

TEST(ImageBufferDecode, Decode_JpegExifOrientation_RotatesPixels) {
  const auto result =
      ImageDecoder::DecodeFile(FixturePath("exif_orient6_40x20.jpg"));
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.format, DecodeFormat::Jpeg);
  // Orientation 6 = rotate 90 CW → 40x20 becomes 20x40
  EXPECT_EQ(result.orientationApplied, 6);
  EXPECT_EQ(result.frame.width, 20);
  EXPECT_EQ(result.frame.height, 40);
  ASSERT_TRUE(result.frame.valid());

  // Asymmetric blue strip must survive orientation (JPEG is lossy — allow tolerance).
  int blueish = 0;
  for (size_t i = 0; i + 2 < result.frame.rgb.size(); i += 3) {
    if (result.frame.rgb[i + 2] > result.frame.rgb[i] + 40 &&
        result.frame.rgb[i + 2] > result.frame.rgb[i + 1] + 40) {
      ++blueish;
    }
  }
  EXPECT_GT(blueish, 50);
}

TEST(ImageBufferDecode, Decode_MaxSide_DownscalesLongestEdge) {
  DecodeOptions opts;
  opts.maxSide = 128;
  const auto result =
      ImageDecoder::DecodeFile(FixturePath("green_512x256.jpg"), opts);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_LE(std::max(result.frame.width, result.frame.height), 128);
  EXPECT_LT(result.scaleApplied, 1.f);
}

TEST(ImageBufferDecode, Decode_MaxSideDisabled_KeepsFullSize) {
  DecodeOptions opts;
  opts.maxSide = 0;
  const auto result =
      ImageDecoder::DecodeFile(FixturePath("green_512x256.jpg"), opts);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.frame.width, 512);
  EXPECT_EQ(result.frame.height, 256);
  EXPECT_FLOAT_EQ(result.scaleApplied, 1.f);
}

TEST(ImageBufferDecode, Decode_JpegAndPng_RoundtripDimensions) {
  {
    const auto r = ImageDecoder::DecodeFile(FixturePath("solid_red_64x48.jpg"));
    ASSERT_TRUE(r.ok) << r.errorMessage;
    EXPECT_EQ(r.frame.width, 64);
    EXPECT_EQ(r.frame.height, 48);
  }
  {
    const auto r = ImageDecoder::DecodeFile(FixturePath("solid_blue_64x48.png"));
    ASSERT_TRUE(r.ok) << r.errorMessage;
    EXPECT_EQ(r.frame.width, 64);
    EXPECT_EQ(r.frame.height, 48);
  }
}

TEST(ImageBufferDecode, Decode_Webp_WhenLibwebpAvailable) {
#if !defined(HAVE_LIBWEBP)
  GTEST_SKIP() << "HAVE_LIBWEBP not set";
#else
  const auto r = ImageDecoder::DecodeFile(FixturePath("solid_red_64x48.webp"));
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_EQ(r.format, DecodeFormat::Webp);
  EXPECT_EQ(r.frame.width, 64);
  EXPECT_EQ(r.frame.height, 48);
#endif
}

TEST(ImageBufferDecode, Decode_Webp_MaxSide_UsesScaledDecode) {
#if !defined(HAVE_LIBWEBP)
  GTEST_SKIP() << "HAVE_LIBWEBP not set";
#else
  DecodeOptions opts;
  opts.maxSide = 32;
  const auto r =
      ImageDecoder::DecodeFile(FixturePath("solid_red_64x48.webp"), opts);
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_EQ(r.format, DecodeFormat::Webp);
  EXPECT_LE(std::max(r.frame.width, r.frame.height), 32);
  EXPECT_EQ(std::max(r.frame.width, r.frame.height), 32);
  EXPECT_LT(r.scaleApplied, 1.f);
  ASSERT_TRUE(r.frame.valid());
  EXPECT_EQ(r.frame.rgb.size(),
            static_cast<size_t>(r.frame.width) * static_cast<size_t>(r.frame.height) *
                3u);
#endif
}

TEST(ImageBufferDecode, Decode_Webp_MaxSideDisabled_KeepsNativeSize) {
#if !defined(HAVE_LIBWEBP)
  GTEST_SKIP() << "HAVE_LIBWEBP not set";
#else
  DecodeOptions opts;
  opts.maxSide = 0;
  const auto r =
      ImageDecoder::DecodeFile(FixturePath("solid_red_64x48.webp"), opts);
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_EQ(r.frame.width, 64);
  EXPECT_EQ(r.frame.height, 48);
  EXPECT_FLOAT_EQ(r.scaleApplied, 1.f);
  ASSERT_TRUE(r.frame.valid());
#endif
}

TEST(ImageBufferDecode, Decode_Webp_WhenLibwebpDisabled) {
#if defined(HAVE_LIBWEBP)
  GTEST_SKIP() << "HAVE_LIBWEBP set";
#else
  const auto r = ImageDecoder::DecodeFile(FixturePath("solid_red_64x48.webp"));
  EXPECT_FALSE(r.ok);
  EXPECT_EQ(r.errorCode, "ERR_IMAGE_WEBP_DISABLED");
  EXPECT_NE(r.errorMessage.find("sherpaOnnxEnableLibwebp"), std::string::npos);
#endif
}
