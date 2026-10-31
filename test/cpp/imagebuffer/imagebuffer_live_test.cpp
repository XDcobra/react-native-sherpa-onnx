#include "ImageRegistry.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

using namespace sherpa_onnx::image;
using sherpa_onnx::image::testutil::FixturePath;
using sherpa_onnx::image::testutil::MakeTempCacheDir;
using sherpa_onnx::image::testutil::ReadFileBytes;
using sherpa_onnx::image::testutil::RemoveDirRecursive;

namespace {

class LiveFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = MakeTempCacheDir("imgbuf_live");
    auto& reg = ImageRegistry::Instance();
    reg.SetCacheDir(cacheDir_);
    reg.ConfigureThreshold(ImageThresholdPlatform::Android,
                           4ULL * 1024ULL * 1024ULL * 1024ULL);
  }

  void TearDown() override { RemoveDirRecursive(cacheDir_); }

  std::string cacheDir_;
};

}  // namespace

TEST_F(LiveFixture, CreateLive_IdPrefixImgLive) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLive(LiveImageOptions{});
  ASSERT_TRUE(created.ok);
  EXPECT_EQ(created.bufferId.rfind("img_live_", 0), 0u);
  EXPECT_EQ(created.info.kind, ImageBufferKind::Live);
  EXPECT_EQ(created.info.state, ImageBufferState::Recording);
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LiveFixture, FinishTwiceAndAppendAfterFinish_InvalidState) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLive(LiveImageOptions{});
  ASSERT_TRUE(created.ok);
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  ASSERT_FALSE(jpeg.empty());
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.FinishLive(created.bufferId).ok);

  auto second = reg.FinishLive(created.bufferId);
  EXPECT_FALSE(second.ok);
  EXPECT_EQ(second.errorCode, "ERR_IMAGE_INVALID_STATE");

  auto append = reg.AppendLiveCompressed(created.bufferId, jpeg);
  EXPECT_FALSE(append.ok);
  EXPECT_EQ(append.errorCode, "ERR_IMAGE_INVALID_STATE");
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LiveFixture, RecordingEnsureAndGetPtr_Rejected) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLive(LiveImageOptions{});
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);

  auto ensured = reg.EnsureFrame(created.bufferId, 0);
  EXPECT_FALSE(ensured.ok);
  EXPECT_EQ(ensured.errorCode, "ERR_IMAGE_INVALID_STATE");

  int w = 0;
  int h = 0;
  EXPECT_EQ(reg.GetFrameRgbPtr(created.bufferId, 0, &w, &h), nullptr);
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LiveFixture, FinishedGetFrameRgbPtr_DecodesOnce) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLive(LiveImageOptions{});
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.FinishLive(created.bufferId).ok);

  ImageBufferInfo info;
  ASSERT_TRUE(reg.GetInfo(created.bufferId, info));
  EXPECT_EQ(info.state, ImageBufferState::Finished);
  EXPECT_EQ(info.frameCount, 1);

  EXPECT_EQ(reg.LiveDecodeCount(created.bufferId), 0);

  int w = 0;
  int h = 0;
  const uint8_t* ptr = reg.GetFrameRgbPtr(created.bufferId, 0, &w, &h);
  ASSERT_NE(ptr, nullptr);
  EXPECT_EQ(w, 64);
  EXPECT_EQ(h, 48);
  EXPECT_EQ(static_cast<size_t>(w) * static_cast<size_t>(h) * 3u, 64u * 48u * 3u);
  EXPECT_EQ(reg.LiveDecodeCount(created.bufferId), 1);

  const uint8_t* ptr2 = reg.GetFrameRgbPtr(created.bufferId, 0, &w, &h);
  ASSERT_NE(ptr2, nullptr);
  EXPECT_EQ(reg.LiveDecodeCount(created.bufferId), 1);

  EXPECT_TRUE(reg.Release(created.bufferId));
  EXPECT_FALSE(reg.GetInfo(created.bufferId, info));
}

TEST_F(LiveFixture, RetentionNone_EvictsOldest) {
  auto& reg = ImageRegistry::Instance();
  LiveImageOptions opts;
  opts.ringFrames = 2;
  opts.retention = ImageRetention::None;
  auto created = reg.CreateLive(opts);
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.FinishLive(created.bufferId).ok);

  ImageBufferInfo info;
  ASSERT_TRUE(reg.GetInfo(created.bufferId, info));
  EXPECT_EQ(info.frameCount, 2);
  EXPECT_EQ(info.ringEvictedFrames, 1);
  EXPECT_FALSE(info.hasActiveSpool);

  ImageFrameInfo f0;
  EXPECT_FALSE(reg.GetFrameInfo(created.bufferId, 0, f0));
  auto e0 = reg.EnsureFrame(created.bufferId, 0);
  EXPECT_FALSE(e0.ok);
  EXPECT_EQ(e0.errorCode, "ERR_IMAGE_FRAME_EVICTED");

  auto e1 = reg.EnsureFrame(created.bufferId, 1);
  ASSERT_TRUE(e1.ok) << e1.errorMessage;
  EXPECT_EQ(e1.info.width, 64);
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LiveFixture, RetentionSession_KeepsEvictedRingFrame) {
  auto& reg = ImageRegistry::Instance();
  LiveImageOptions opts;
  opts.ringFrames = 2;
  opts.retention = ImageRetention::Session;
  auto created = reg.CreateLive(opts);
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.AppendLiveCompressed(created.bufferId, jpeg).ok);
  ASSERT_TRUE(reg.FinishLive(created.bufferId).ok);

  ImageBufferInfo info;
  ASSERT_TRUE(reg.GetInfo(created.bufferId, info));
  EXPECT_EQ(info.frameCount, 3);
  EXPECT_EQ(info.ringEvictedFrames, 1);
  EXPECT_TRUE(info.hasActiveSpool);

  auto e0 = reg.EnsureFrame(created.bufferId, 0);
  ASSERT_TRUE(e0.ok) << e0.errorMessage;
  EXPECT_EQ(e0.info.width, 64);
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LiveFixture, OfflinePrefixUnchanged) {
  auto& reg = ImageRegistry::Instance();
  const std::string id = reg.CreateEmpty();
  EXPECT_EQ(id.rfind("img_off_", 0), 0u);
  EXPECT_TRUE(reg.Release(id));
}
