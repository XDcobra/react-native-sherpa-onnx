#include "ImageMmapThreshold.h"
#include "ImageRegistry.h"
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
using sherpa_onnx::image::testutil::SetFileAgeMs;

namespace {

constexpr uint64_t kMidRamBytes = 4ULL * 1024ULL * 1024ULL * 1024ULL;  // 4 GiB → Mid
constexpr int64_t kMb = 1024LL * 1024LL;

class MmapFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = MakeTempCacheDir("imgbuf_mmap");
    auto& reg = ImageRegistry::Instance();
    reg.SetCacheDir(cacheDir_);
    reg.ConfigureThreshold(ImageThresholdPlatform::Android, kMidRamBytes);
  }

  void TearDown() override { RemoveDirRecursive(cacheDir_); }

  std::string ExpectedMmapPath(const std::string& bufferId, int frameIndex) const {
    std::string idPart = bufferId;
    constexpr const char* kPrefix = "img_off_";
    if (idPart.rfind(kPrefix, 0) == 0) {
      idPart = idPart.substr(8);
    }
    return cacheDir_ + "/img_off_" + idPart + "_f" + std::to_string(frameIndex) +
           ".rgb8";
  }

  std::string cacheDir_;
};

}  // namespace

TEST(ImageBufferThreshold, Threshold_ClassifyRamBuckets) {
  EXPECT_EQ(ImageMmapThreshold::ClassifyRam(2ULL * 1024ULL * 1024ULL * 1024ULL),
            ImageRamClass::Low);
  EXPECT_EQ(ImageMmapThreshold::ClassifyRam(kMidRamBytes), ImageRamClass::Mid);
  EXPECT_EQ(ImageMmapThreshold::ClassifyRam(8ULL * 1024ULL * 1024ULL * 1024ULL),
            ImageRamClass::High);
  EXPECT_EQ(ImageMmapThreshold::ClassifyRam(16ULL * 1024ULL * 1024ULL * 1024ULL),
            ImageRamClass::VeryHigh);
}

TEST(ImageBufferThreshold, Threshold_FileOriginLessThanHeap) {
  for (auto platform :
       {ImageThresholdPlatform::Android, ImageThresholdPlatform::Ios}) {
    for (auto ram : {ImageRamClass::Low, ImageRamClass::Mid, ImageRamClass::High,
                     ImageRamClass::VeryHigh}) {
      const int64_t fileT = ImageMmapThreshold::ThresholdBytes(
          platform, ram, ImageThresholdPathType::FileOrigin);
      const int64_t heapT = ImageMmapThreshold::ThresholdBytes(
          platform, ram, ImageThresholdPathType::HeapOrigin);
      EXPECT_LT(fileT, heapT) << ImageMmapThreshold::RamClassName(ram);
    }
  }
}

TEST(ImageBufferThreshold, Threshold_Clamp4to32MB) {
  // Mid Android file = 6 MB (within clamp)
  EXPECT_EQ(ImageMmapThreshold::ThresholdBytes(ImageThresholdPlatform::Android,
                                               ImageRamClass::Mid,
                                               ImageThresholdPathType::FileOrigin),
            6 * kMb);
  // VeryHigh Android heap = 10 * 2 = 20 MB
  EXPECT_EQ(ImageMmapThreshold::ThresholdBytes(ImageThresholdPlatform::Android,
                                               ImageRamClass::VeryHigh,
                                               ImageThresholdPathType::HeapOrigin),
            20 * kMb);
  // VeryHigh iOS heap = 12 * 2 = 24 MB
  EXPECT_EQ(ImageMmapThreshold::ThresholdBytes(ImageThresholdPlatform::Ios,
                                               ImageRamClass::VeryHigh,
                                               ImageThresholdPathType::HeapOrigin),
            24 * kMb);
  // Low Android file = 6 * 0.75 = 4.5 → rounds to 4.5 MB, still >= 4 MB clamp min
  const int64_t lowFile = ImageMmapThreshold::ThresholdBytes(
      ImageThresholdPlatform::Android, ImageRamClass::Low,
      ImageThresholdPathType::FileOrigin);
  EXPECT_GE(lowFile, 4 * kMb);
  EXPECT_LE(lowFile, 32 * kMb);
}

TEST_F(MmapFixture, Mmap_SmallBufferStaysRam) {
  auto& reg = ImageRegistry::Instance();
  // 64x64 RGB ≈ 12 KB ≪ 6 MB file threshold
  auto frame = MakeSolidRgb(64, 64, 10, 20, 30);
  auto result = reg.CreateFromRgbFrames({std::move(frame)},
                                        ImageThresholdPathType::FileOrigin);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.info.storageKind, ImageStorageKind::Ram);
  EXPECT_FALSE(FileExists(ExpectedMmapPath(result.bufferId, 0)));
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(MmapFixture, Mmap_LargeSyntheticFrames_UpgradeWritesRgb8Files) {
  auto& reg = ImageRegistry::Instance();
  // 2048x2048x3 ≈ 12 MB > Android Mid file threshold (6 MB)
  auto frame = MakeSolidRgb(2048, 2048, 1, 2, 3);
  auto result = reg.CreateFromRgbFrames({std::move(frame)},
                                        ImageThresholdPathType::FileOrigin);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.info.storageKind, ImageStorageKind::Mmap);
  EXPECT_TRUE(FileExists(ExpectedMmapPath(result.bufferId, 0)));

  ImageFrameInfo fi;
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 0, fi));
  EXPECT_EQ(fi.storageKind, ImageStorageKind::Mmap);

  EXPECT_TRUE(reg.Release(result.bufferId));
  EXPECT_FALSE(FileExists(ExpectedMmapPath(result.bufferId, 0)));
}

TEST_F(MmapFixture, GetFrameRgbPtr_MatchesKnownPattern_BeforeAndAfterMmap) {
  auto& reg = ImageRegistry::Instance();

  // RAM path
  {
    auto frame = MakeSolidRgb(32, 16, 9, 8, 7);
    auto result = reg.CreateFromRgbFrames({std::move(frame)},
                                          ImageThresholdPathType::FileOrigin);
    ASSERT_TRUE(result.ok);
    int w = 0, h = 0;
    const uint8_t* ptr = reg.GetFrameRgbPtr(result.bufferId, 0, &w, &h);
    ASSERT_NE(ptr, nullptr);
    EXPECT_EQ(w, 32);
    EXPECT_EQ(h, 16);
    EXPECT_EQ(ptr[0], 9);
    EXPECT_EQ(ptr[1], 8);
    EXPECT_EQ(ptr[2], 7);
    EXPECT_TRUE(reg.Release(result.bufferId));
  }

  // mmap path
  {
    auto frame = MakeSolidRgb(2048, 2048, 11, 22, 33);
    auto result = reg.CreateFromRgbFrames({std::move(frame)},
                                          ImageThresholdPathType::FileOrigin);
    ASSERT_TRUE(result.ok);
    EXPECT_EQ(result.info.storageKind, ImageStorageKind::Mmap);
    int w = 0, h = 0;
    const uint8_t* ptr = reg.GetFrameRgbPtr(result.bufferId, 0, &w, &h);
    ASSERT_NE(ptr, nullptr);
    EXPECT_EQ(w, 2048);
    EXPECT_EQ(h, 2048);
    EXPECT_EQ(ptr[0], 11);
    EXPECT_EQ(ptr[1], 22);
    EXPECT_EQ(ptr[2], 33);
    // Spot-check last pixel
    const size_t last = static_cast<size_t>(2048) * 2048 * 3 - 3;
    EXPECT_EQ(ptr[last], 11);
    EXPECT_EQ(ptr[last + 1], 22);
    EXPECT_EQ(ptr[last + 2], 33);
    EXPECT_TRUE(reg.Release(result.bufferId));
  }
}

TEST_F(MmapFixture, PostAdopt_AppendUntilOverThreshold_ThenMaybeUpgrade) {
  auto& reg = ImageRegistry::Instance();
  const std::string id = reg.CreateEmpty();

  // First small append stays RAM
  ASSERT_TRUE(reg.AppendRgbFrame(id, MakeSolidRgb(64, 64, 1, 1, 1),
                                 ImageThresholdPathType::HeapOrigin));
  ImageBufferInfo info;
  ASSERT_TRUE(reg.GetInfo(id, info));
  EXPECT_EQ(info.storageKind, ImageStorageKind::Ram);

  // Append a large frame (heap Mid threshold = 10 MB; 2048² ≈ 12 MB)
  ASSERT_TRUE(reg.AppendRgbFrame(id, MakeSolidRgb(2048, 2048, 5, 5, 5),
                                 ImageThresholdPathType::HeapOrigin));
  ASSERT_TRUE(reg.GetInfo(id, info));
  EXPECT_EQ(info.storageKind, ImageStorageKind::Mmap);
  EXPECT_GE(info.frameCount, 2);

  // Explicit re-eval path (already mmap; should remain)
  reg.MaybeUpgradeToMmap(id, ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(reg.GetInfo(id, info));
  EXPECT_EQ(info.storageKind, ImageStorageKind::Mmap);

  EXPECT_TRUE(reg.Release(id));
}

TEST_F(MmapFixture, Release_UnlinksMmapFiles) {
  auto& reg = ImageRegistry::Instance();
  auto result = reg.CreateFromRgbFrames({MakeSolidRgb(2048, 2048, 4, 5, 6)},
                                        ImageThresholdPathType::FileOrigin);
  ASSERT_TRUE(result.ok);
  const std::string path = ExpectedMmapPath(result.bufferId, 0);
  ASSERT_TRUE(FileExists(path));
  EXPECT_TRUE(reg.Release(result.bufferId));
  EXPECT_FALSE(FileExists(path));
}

TEST_F(MmapFixture, OrphanSweep_DeletesOldKeepsYoung) {
  auto& reg = ImageRegistry::Instance();
  const std::string oldPath = cacheDir_ + "/img_off_orphan-old_f0.rgb8";
  const std::string youngPath = cacheDir_ + "/img_off_orphan-young_f0.rgb8";
  const std::string otherPath = cacheDir_ + "/pa_off_not_image.f32";

  {
    std::ofstream(oldPath, std::ios::binary) << std::string(64, '\x01');
    std::ofstream(youngPath, std::ios::binary) << std::string(64, '\x02');
    std::ofstream(otherPath, std::ios::binary) << std::string(64, '\x03');
  }
  ASSERT_TRUE(SetFileAgeMs(oldPath, 2LL * 60LL * 60LL * 1000LL));  // 2h
  ASSERT_TRUE(SetFileAgeMs(youngPath, 5LL * 60LL * 1000LL));       // 5m

  const int deleted = reg.SweepOrphanedTempFiles(/*maxAgeMs=*/3'600'000);
  EXPECT_GE(deleted, 1);
  EXPECT_FALSE(FileExists(oldPath));
  EXPECT_TRUE(FileExists(youngPath));
  EXPECT_TRUE(FileExists(otherPath));  // wrong prefix/suffix must survive
}
