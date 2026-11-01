#include "ImageFrameEncoder.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecPolicy.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecTypes.h"
#include "encode/ImageEncodeBackend.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <cstdio>
#include <string>

using namespace sherpa_onnx::image;
using namespace sherpa_onnx::codec;
using sherpa_onnx::image::testutil::MakeSolidRgb;
using sherpa_onnx::image::testutil::MakeTempCacheDir;
using sherpa_onnx::image::testutil::RemoveDirRecursive;

namespace {

Provider MakeEncode(const char* name, const char* codec, Tier tier,
                    Origin origin, bool available, Reason reason = Reason::None,
                    int rank = 0) {
  Provider p;
  p.media = Media::Image;
  p.dir = Direction::Encode;
  p.codec = codec;
  p.tier = tier;
  p.origin = origin;
  p.name = name;
  p.available = available;
  p.unavailableReason = reason;
  p.rank = rank;
  return p;
}

class EncodeSelectFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    CodecRuntime::Instance().ResetForTest();
    dir_ = MakeTempCacheDir("imgbuf_encode_select");
  }
  void TearDown() override {
    RemoveDirRecursive(dir_);
    CodecRuntime::Instance().ResetForTest();
  }

  std::string PathInDir(const char* name) const { return dir_ + "/" + name; }

  std::string dir_;
};

}  // namespace

TEST(ExportFormatParse, AcceptsHeicAliases) {
  ExportFormat f = ExportFormat::Jpeg;
  EXPECT_TRUE(ParseExportFormat("heic", &f));
  EXPECT_EQ(f, ExportFormat::Heic);
  EXPECT_TRUE(ParseExportFormat("HEIF", &f));
  EXPECT_EQ(f, ExportFormat::Heic);
  EXPECT_STREQ(ExportFormatName(ExportFormat::Heic), "heic");
}

TEST_F(EncodeSelectFixture, JpegPreferHardwareHostUsesStb) {
  RegisterPortableImageEncodeProviders();
  RegisterPlatformImageEncodeProviders();
  RgbFrame frame = MakeSolidRgb(24, 16, 200, 10, 10);
  const std::string out = PathInDir("pref.jpg");
  ExportOptions opts;
  opts.format = ExportFormat::Jpeg;
  opts.encodePolicy = "preferHardware";
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_EQ(r.codecProvider, "stb");
  EXPECT_EQ(r.codecTier, "software");
  EXPECT_EQ(r.codecOrigin, "bundled");
}

TEST_F(EncodeSelectFixture, JpegHardwareWithoutPlatformFails) {
  RegisterPortableImageEncodeProviders();
  CodecCatalog::Instance().Register(MakeEncode(
      "AndroidBitmap", "jpeg", Tier::Hardware, Origin::Platform, false,
      Reason::OsTooOld));
  RgbFrame frame = MakeSolidRgb(16, 16, 10, 10, 10);
  const std::string out = PathInDir("hw.jpg");
  ExportOptions opts;
  opts.format = ExportFormat::Jpeg;
  opts.encodePolicy = "hardware";
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_FALSE(r.ok);
  EXPECT_EQ(r.errorCode, kErrImageHwEncoderUnavailable);
}

TEST_F(EncodeSelectFixture, JpegApi24PlanSoftwareOnly) {
  CodecCatalog catalog;
  catalog.Register(MakeEncode("AndroidBitmap", "jpeg", Tier::Hardware,
                              Origin::Platform, false, Reason::OsTooOld));
  catalog.Register(MakeEncode("stb", "jpeg", Tier::Software, Origin::Bundled,
                              true, Reason::None, 1));
  Request req;
  req.media = Media::Image;
  req.dir = Direction::Encode;
  req.use = Use::Export;
  req.stream.codec = "jpeg";
  req.policy = Policy::PreferHardware;
  req.ownerKey = "image-encode";
  const Plan pref = MakePlan(req, catalog);
  ASSERT_EQ(pref.steps.size(), 1u);
  EXPECT_EQ(pref.steps[0].provider->name, "stb");
  ASSERT_FALSE(pref.skipped.empty());
  EXPECT_EQ(pref.skipped[0].reason, Reason::OsTooOld);

  req.policy = Policy::Hardware;
  const Plan hw = MakePlan(req, catalog);
  EXPECT_TRUE(hw.steps.empty());
}

TEST_F(EncodeSelectFixture, JpegApi30PlanPrefersPlatform) {
  CodecCatalog catalog;
  catalog.Register(MakeEncode("AndroidBitmap", "jpeg", Tier::Hardware,
                              Origin::Platform, true));
  catalog.Register(MakeEncode("stb", "jpeg", Tier::Software, Origin::Bundled,
                              true, Reason::None, 1));
  Request req;
  req.media = Media::Image;
  req.dir = Direction::Encode;
  req.use = Use::Export;
  req.stream.codec = "jpeg";
  req.policy = Policy::PreferHardware;
  req.ownerKey = "image-encode";
  const Plan plan = MakePlan(req, catalog);
  ASSERT_EQ(plan.steps.size(), 2u);
  EXPECT_EQ(plan.steps[0].provider->name, "AndroidBitmap");
  EXPECT_EQ(plan.steps[1].provider->name, "stb");
}

TEST_F(EncodeSelectFixture, WebpPreferHardwareKeepsLibwebpWhenLinked) {
  RegisterPortableImageEncodeProviders();
  CodecCatalog::Instance().Register(MakeEncode(
      "AndroidBitmap", "webp", Tier::Hardware, Origin::Platform, true));
  RgbFrame frame = MakeSolidRgb(20, 20, 10, 10, 200);
  const std::string out = PathInDir("pref.webp");
  ExportOptions opts;
  opts.format = ExportFormat::Webp;
  opts.encodePolicy = "preferHardware";
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
#if defined(HAVE_LIBWEBP)
  ASSERT_TRUE(r.ok) << r.errorMessage;
  EXPECT_EQ(r.codecProvider, "libwebp");
  EXPECT_EQ(r.codecTier, "software");
#else
  ASSERT_FALSE(r.ok);
  EXPECT_EQ(r.errorCode, kErrImageWebpDisabled);
#endif
}

TEST_F(EncodeSelectFixture, WebpHardwareWithoutPlatformFails) {
  RegisterPortableImageEncodeProviders();
  RgbFrame frame = MakeSolidRgb(12, 12, 1, 2, 3);
  const std::string out = PathInDir("hw.webp");
  ExportOptions opts;
  opts.format = ExportFormat::Webp;
  opts.encodePolicy = "hardware";
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_FALSE(r.ok);
  EXPECT_EQ(r.errorCode, kErrImageHwEncoderUnavailable);
}

TEST_F(EncodeSelectFixture, HeicSoftwareUnavailable) {
  RegisterPortableImageEncodeProviders();
  RegisterPlatformImageEncodeProviders();
  RgbFrame frame = MakeSolidRgb(8, 8, 4, 4, 4);
  const std::string out = PathInDir("sw.heic");
  ExportOptions opts;
  opts.format = ExportFormat::Heic;
  opts.encodePolicy = "software";
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_FALSE(r.ok);
  EXPECT_EQ(r.errorCode, kErrImageSwEncoderUnavailable);
}

TEST_F(EncodeSelectFixture, HeicHardwareWithoutImageIOFails) {
  RegisterPortableImageEncodeProviders();
  RegisterPlatformImageEncodeProviders();
  RgbFrame frame = MakeSolidRgb(8, 8, 4, 4, 4);
  const std::string out = PathInDir("hw.heic");
  ExportOptions opts;
  opts.format = ExportFormat::Heic;
  opts.encodePolicy = "hardware";
  const auto r =
      EncodeRgbBytesToFile(frame.rgb.data(), frame.width, frame.height, out, opts);
  ASSERT_FALSE(r.ok);
  EXPECT_EQ(r.errorCode, kErrImageHwEncoderUnavailable);
}

TEST(ImageEncodeErrorCodes, DistinguishesEncodeFromDecode) {
  Request req;
  req.media = Media::Image;
  req.dir = Direction::Encode;
  EXPECT_STREQ(ErrorCodeFor(req, Reason::NotPresent, Tier::Hardware),
               kErrImageHwEncoderUnavailable);
  EXPECT_STREQ(ErrorCodeFor(req, Reason::NotPresent, Tier::Software),
               kErrImageSwEncoderUnavailable);
  EXPECT_STREQ(ErrorCodeFor(req, Reason::Disabled, Tier::Software),
               kErrImageWebpDisabled);
  req.dir = Direction::Decode;
  EXPECT_STREQ(ErrorCodeFor(req, Reason::NotPresent, Tier::Hardware),
               kErrImageHwDecoderUnavailable);
}
