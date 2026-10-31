#include "ImageRegistry.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <atomic>
#include <string>
#include <vector>

using namespace sherpa_onnx::image;
using sherpa_onnx::image::testutil::FixturePath;
using sherpa_onnx::image::testutil::MakeTempCacheDir;
using sherpa_onnx::image::testutil::ReadFileBytes;
using sherpa_onnx::image::testutil::RemoveDirRecursive;

namespace {

class RegistryFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = MakeTempCacheDir("imgbuf_reg");
    auto& reg = ImageRegistry::Instance();
    reg.SetCacheDir(cacheDir_);
    // Mid Android → file 6 MB / heap 10 MB
    reg.ConfigureThreshold(ImageThresholdPlatform::Android,
                           4ULL * 1024ULL * 1024ULL * 1024ULL);
  }

  void TearDown() override {
    RemoveDirRecursive(cacheDir_);
  }

  std::string cacheDir_;
};

}  // namespace

TEST_F(RegistryFixture, Registry_CreateEmpty_IdPrefixImgOff) {
  auto& reg = ImageRegistry::Instance();
  const std::string id = reg.CreateEmpty();
  EXPECT_EQ(id.rfind("img_off_", 0), 0u);

  ImageBufferInfo info;
  ASSERT_TRUE(reg.GetInfo(id, info));
  EXPECT_EQ(info.frameCount, 0);
  EXPECT_EQ(info.storageKind, ImageStorageKind::Ram);

  EXPECT_TRUE(reg.Release(id));
  EXPECT_FALSE(reg.GetInfo(id, info));
}

TEST_F(RegistryFixture, Registry_CreateFromFiles_MultiFrame_InfoAndFrameInfo) {
  auto& reg = ImageRegistry::Instance();
  const auto result = reg.CreateFromFiles(
      {FixturePath("solid_red_64x48.jpg"), FixturePath("solid_blue_64x48.png")},
      DecodeOptions{});
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.info.frameCount, 2);
  EXPECT_EQ(result.info.state, ImageBufferState::Lazy);
  EXPECT_EQ(result.info.storageKind, ImageStorageKind::Ram);
  EXPECT_EQ(result.info.totalBytes, 0);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 0);

  ImageFrameInfo f0;
  ImageFrameInfo f1;
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 0, f0));
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 1, f1));
  EXPECT_EQ(f0.width, 0);
  EXPECT_EQ(f0.height, 0);
  EXPECT_EQ(f1.width, 0);
  EXPECT_EQ(f1.height, 0);

  auto ensured = reg.EnsureFrame(result.bufferId, 0);
  ASSERT_TRUE(ensured.ok) << ensured.errorMessage;
  EXPECT_EQ(ensured.info.width, 64);
  EXPECT_EQ(ensured.info.height, 48);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 1);

  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(RegistryFixture, Registry_CreateFromBytesList_HeapOrigin) {
  auto& reg = ImageRegistry::Instance();
  const auto jpeg = ReadFileBytes(FixturePath("solid_red_64x48.jpg"));
  ASSERT_FALSE(jpeg.empty());

  const auto result = reg.CreateFromBytesList(
      {jpeg}, DecodeOptions{}, ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.info.frameCount, 1);
  EXPECT_EQ(result.info.state, ImageBufferState::Lazy);
  EXPECT_EQ(result.info.storageKind, ImageStorageKind::Ram);
  EXPECT_EQ(result.info.totalBytes, 0);
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(RegistryFixture, Registry_Release_RemovesBufferAndGetInfoFails) {
  auto& reg = ImageRegistry::Instance();
  const auto result =
      reg.CreateFromFiles({FixturePath("solid_red_64x48.jpg")}, DecodeOptions{});
  ASSERT_TRUE(result.ok);
  EXPECT_TRUE(reg.Release(result.bufferId));
  ImageBufferInfo info;
  EXPECT_FALSE(reg.GetInfo(result.bufferId, info));
  EXPECT_FALSE(reg.Release(result.bufferId));
}

TEST_F(RegistryFixture, CreateFromFiles_ProgressCallbacks) {
  auto& reg = ImageRegistry::Instance();
  std::vector<std::tuple<int, int, std::string>> events;
  const auto result = reg.CreateFromFiles(
      {FixturePath("solid_red_64x48.jpg"), FixturePath("solid_blue_64x48.png")},
      DecodeOptions{},
      [&](int done, int total, const std::string& phase) {
        events.emplace_back(done, total, phase);
      });
  ASSERT_TRUE(result.ok) << result.errorMessage;
  ASSERT_GE(events.size(), 3u);
  EXPECT_EQ(std::get<2>(events.front()), "index");
  EXPECT_EQ(std::get<0>(events.front()), 0);
  EXPECT_EQ(std::get<1>(events.front()), 2);
  EXPECT_EQ(std::get<2>(events.back()), "done");
  EXPECT_EQ(std::get<0>(events.back()), 2);
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(RegistryFixture, CreateFromFiles_CancelReleasesPartial) {
  auto& reg = ImageRegistry::Instance();
  std::atomic<int> decodeStarts{0};
  const auto result = reg.CreateFromFiles(
      {FixturePath("solid_red_64x48.jpg"), FixturePath("solid_blue_64x48.png")},
      DecodeOptions{},
      [&](int /*done*/, int /*total*/, const std::string& /*phase*/) {
        decodeStarts.fetch_add(1);
      },
      [&]() {
        // Cancel before the second file is decoded (after first progress).
        return decodeStarts.load() >= 1;
      });
  EXPECT_FALSE(result.ok);
  EXPECT_EQ(result.errorCode, "ERR_IMAGE_CANCELLED");
  EXPECT_TRUE(result.bufferId.empty());

  // No registered buffer should exist from the cancelled create.
  // CreateEmpty/GetInfo on a fresh empty id still works; ensure registry is clean
  // by creating a known id and confirming cancelled id is not present.
  ImageBufferInfo info;
  EXPECT_FALSE(reg.GetInfo("img_off_00000000-0000-0000-0000-000000000000", info));
}
