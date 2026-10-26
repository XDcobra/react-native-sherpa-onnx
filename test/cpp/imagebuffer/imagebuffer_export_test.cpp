#include "ImageFrameEncoder.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

using namespace sherpa_onnx::image;
using sherpa_onnx::image::testutil::FileExists;
using sherpa_onnx::image::testutil::MakeSolidRgb;
using sherpa_onnx::image::testutil::MakeTempCacheDir;
using sherpa_onnx::image::testutil::RemoveDirRecursive;

namespace {

class ExportFixture : public ::testing::Test {
 protected:
  void SetUp() override { dir_ = MakeTempCacheDir("imgbuf_export"); }
  void TearDown() override { RemoveDirRecursive(dir_); }

  std::string PathInDir(const char* name) const { return dir_ + "/" + name; }

  static size_t FileSize(const std::string& path) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) return 0;
    return static_cast<size_t>(in.tellg());
  }

  std::string dir_;
};

}  // namespace

TEST_F(ExportFixture, EncodeRgbBytesToFile_Jpeg) {
  RgbFrame frame = MakeSolidRgb(32, 24, 200, 10, 10);
  const std::string out = PathInDir("solid.jpg");
  ExportOptions opts;
  opts.format = ExportFormat::Jpeg;
  opts.quality = 85;
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_TRUE(FileExists(out));
  EXPECT_GT(FileSize(out), 32u);
}

TEST_F(ExportFixture, EncodeRgbBytesToFile_Png) {
  RgbFrame frame = MakeSolidRgb(16, 16, 0, 180, 0);
  const std::string out = PathInDir("solid.png");
  ExportOptions opts;
  opts.format = ExportFormat::Png;
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_TRUE(FileExists(out));
  EXPECT_GT(FileSize(out), 16u);
}

TEST_F(ExportFixture, EncodeRgbBytesToFile_Webp) {
#if !defined(HAVE_LIBWEBP) || !HAVE_LIBWEBP
  GTEST_SKIP() << "libwebp not linked in host test";
#else
  RgbFrame frame = MakeSolidRgb(20, 20, 10, 10, 200);
  const std::string out = PathInDir("solid.webp");
  ExportOptions opts;
  opts.format = ExportFormat::Webp;
  opts.quality = 80;
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_TRUE(FileExists(out));
  EXPECT_GT(FileSize(out), 16u);
#endif
}

TEST_F(ExportFixture, ParseExportFormat) {
  ExportFormat f = ExportFormat::Jpeg;
  EXPECT_TRUE(ParseExportFormat("JPEG", &f));
  EXPECT_EQ(f, ExportFormat::Jpeg);
  EXPECT_TRUE(ParseExportFormat("png", &f));
  EXPECT_EQ(f, ExportFormat::Png);
  EXPECT_TRUE(ParseExportFormat("webp", &f));
  EXPECT_EQ(f, ExportFormat::Webp);
  EXPECT_FALSE(ParseExportFormat("gif", &f));
}
