#include "ImageRegistry.h"
#include "decode/ImageDecoder.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <string>
#include <vector>

using namespace sherpa_onnx::image;
using sherpa_onnx::image::testutil::FixturePath;
using sherpa_onnx::image::testutil::MakeSolidRgb;
using sherpa_onnx::image::testutil::MakeTempCacheDir;
using sherpa_onnx::image::testutil::ReadFileBytes;
using sherpa_onnx::image::testutil::RemoveDirRecursive;

namespace {

class FileLazyFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = MakeTempCacheDir("imgbuf_file_lazy");
    auto& reg = ImageRegistry::Instance();
    reg.SetCacheDir(cacheDir_);
    reg.ConfigureThreshold(ImageThresholdPlatform::Android,
                           4ULL * 1024ULL * 1024ULL * 1024ULL);
    ImageDecoder::SetPlatformHeicDecoder(nullptr);
  }

  void TearDown() override {
    ImageDecoder::SetPlatformHeicDecoder(nullptr);
    RemoveDirRecursive(cacheDir_);
  }

  std::string cacheDir_;
};

std::vector<uint8_t> MinimalHeicBrand() {
  std::vector<uint8_t> heic(32, 0);
  heic[3] = 0x18;
  heic[4] = 'f';
  heic[5] = 't';
  heic[6] = 'y';
  heic[7] = 'p';
  heic[8] = 'h';
  heic[9] = 'e';
  heic[10] = 'i';
  heic[11] = 'c';
  return heic;
}

}  // namespace

TEST_F(FileLazyFixture, CreateFromFiles_IsLazyUntilEnsure) {
  auto& reg = ImageRegistry::Instance();
  const auto result = reg.CreateFromFiles(
      {FixturePath("solid_red_64x48.jpg"), FixturePath("solid_blue_64x48.png"),
       FixturePath("solid_red_64x48.webp")},
      DecodeOptions{});
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.info.state, ImageBufferState::Lazy);
  EXPECT_EQ(result.info.frameCount, 3);
  EXPECT_EQ(result.info.totalBytes, 0);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 0);

  ImageFrameInfo cold;
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 0, cold));
  EXPECT_EQ(cold.width, 0);
  EXPECT_EQ(cold.height, 0);

  auto e0 = reg.EnsureFrame(result.bufferId, 0);
  ASSERT_TRUE(e0.ok) << e0.errorMessage;
  EXPECT_EQ(e0.info.width, 64);
  EXPECT_EQ(e0.info.height, 48);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 1);

  ImageFrameInfo stillCold;
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 1, stillCold));
  EXPECT_EQ(stillCold.width, 0);

  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(FileLazyFixture, GetFrameRgbPtr_AutoEnsuresColdFileSlot) {
  auto& reg = ImageRegistry::Instance();
  const auto result =
      reg.CreateFromFiles({FixturePath("solid_red_64x48.jpg")}, DecodeOptions{});
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 0);

  int w = 0;
  int h = 0;
  const uint8_t* ptr = reg.GetFrameRgbPtr(result.bufferId, 0, &w, &h);
  ASSERT_NE(ptr, nullptr);
  EXPECT_EQ(w, 64);
  EXPECT_EQ(h, 48);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 1);
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(FileLazyFixture, HotFramesTwo_EvictsOldestKeepsSlot) {
  auto& reg = ImageRegistry::Instance();
  DecodeOptions opts;
  opts.hotFrames = 2;
  const auto result = reg.CreateFromFiles(
      {FixturePath("solid_red_64x48.jpg"), FixturePath("solid_blue_64x48.png"),
       FixturePath("green_512x256.jpg")},
      opts);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), 0);

  auto countHot = [&]() {
    int hot = 0;
    for (int i = 0; i < 3; ++i) {
      ImageFrameInfo info;
      if (!reg.GetFrameInfo(result.bufferId, i, info)) continue;
      if (info.width > 0 && info.height > 0) ++hot;
    }
    return hot;
  };

  ASSERT_TRUE(reg.EnsureFrame(result.bufferId, 0).ok);
  EXPECT_LE(countHot(), 2);
  ASSERT_TRUE(reg.EnsureFrame(result.bufferId, 1).ok);
  EXPECT_LE(countHot(), 2);
  ASSERT_TRUE(reg.EnsureFrame(result.bufferId, 2).ok);
  EXPECT_LE(countHot(), 2);
  // Explicit ensures plus optional ±1 prefetch (same as PDF lazy-lru).
  EXPECT_GE(reg.FileLazyDecodeCount(result.bufferId), 3);

  ImageFrameInfo f0;
  ImageFrameInfo f1;
  ImageFrameInfo f2;
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 0, f0));
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 1, f1));
  ASSERT_TRUE(reg.GetFrameInfo(result.bufferId, 2, f2));
  EXPECT_EQ(f0.width, 0);
  EXPECT_EQ(f0.height, 0);
  EXPECT_GT(f1.width, 0);
  EXPECT_GT(f2.width, 0);

  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(FileLazyFixture, CreateFromRgbFrames_EnsureIsNoOp) {
  auto& reg = ImageRegistry::Instance();
  auto frame = MakeSolidRgb(16, 8, 1, 2, 3);
  const auto result =
      reg.CreateFromRgbFrames({std::move(frame)}, ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  EXPECT_EQ(result.info.state, ImageBufferState::Immutable);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), -1);

  auto ensured = reg.EnsureFrame(result.bufferId, 0);
  ASSERT_TRUE(ensured.ok) << ensured.errorMessage;
  EXPECT_EQ(ensured.info.width, 16);
  EXPECT_EQ(ensured.info.height, 8);
  EXPECT_EQ(reg.FileLazyDecodeCount(result.bufferId), -1);
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(FileLazyFixture, HeicWithoutHook_EnsureFails) {
  auto& reg = ImageRegistry::Instance();
  const auto heic = MinimalHeicBrand();
  const auto result = reg.CreateFromBytesList(
      {heic}, DecodeOptions{}, ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  auto ensured = reg.EnsureFrame(result.bufferId, 0);
  EXPECT_FALSE(ensured.ok);
  EXPECT_EQ(ensured.errorCode, "ERR_IMAGE_FORMAT_UNSUPPORTED");
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(FileLazyFixture, HeicWithHook_EnsureDecodesRgb) {
  auto& reg = ImageRegistry::Instance();
  ImageDecoder::SetPlatformHeicDecoder(
      [](const uint8_t*, size_t, const DecodeOptions&) {
        DecodeResult r;
        r.ok = true;
        r.format = DecodeFormat::Heic;
        r.frame = MakeSolidRgb(10, 6, 9, 8, 7);
        return r;
      });
  const auto heic = MinimalHeicBrand();
  const auto result = reg.CreateFromBytesList(
      {heic}, DecodeOptions{}, ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  auto ensured = reg.EnsureFrame(result.bufferId, 0);
  ASSERT_TRUE(ensured.ok) << ensured.errorMessage;
  EXPECT_EQ(ensured.info.width, 10);
  EXPECT_EQ(ensured.info.height, 6);
  int w = 0;
  int h = 0;
  const uint8_t* ptr = reg.GetFrameRgbPtr(result.bufferId, 0, &w, &h);
  ASSERT_NE(ptr, nullptr);
  EXPECT_EQ(ptr[0], 9);
  EXPECT_EQ(ptr[1], 8);
  EXPECT_EQ(ptr[2], 7);
  EXPECT_TRUE(reg.Release(result.bufferId));
}

TEST_F(FileLazyFixture, WebpMaxSide_ScaledOnEnsure) {
#if !defined(HAVE_LIBWEBP)
  GTEST_SKIP() << "HAVE_LIBWEBP not set";
#else
  auto& reg = ImageRegistry::Instance();
  DecodeOptions opts;
  opts.maxSide = 32;
  const auto result =
      reg.CreateFromFiles({FixturePath("solid_red_64x48.webp")}, opts);
  ASSERT_TRUE(result.ok) << result.errorMessage;
  auto ensured = reg.EnsureFrame(result.bufferId, 0);
  ASSERT_TRUE(ensured.ok) << ensured.errorMessage;
  EXPECT_EQ(std::max(ensured.info.width, ensured.info.height), 32);
  EXPECT_TRUE(reg.Release(result.bufferId));
#endif
}

// ---- Expected sizes and loader slots (archive images) ----------------------

TEST(ImageDecoderExpectedSize, HeadersExifAndMaxSide) {
  const auto jpg = ReadFileBytes(FixturePath("green_512x256.jpg"));
  ASSERT_FALSE(jpg.empty());
  int w = 0;
  int h = 0;
  DecodeOptions opts;
  opts.maxSide = 0;
  ASSERT_TRUE(ImageDecoder::ExpectedDecodedSize(jpg.data(), jpg.size(), opts, &w, &h));
  EXPECT_EQ(w, 512);
  EXPECT_EQ(h, 256);
  opts.maxSide = 128;
  ASSERT_TRUE(ImageDecoder::ExpectedDecodedSize(jpg.data(), jpg.size(), opts, &w, &h));
  EXPECT_EQ(w, 128);
  EXPECT_EQ(h, 64);
  // EXIF orientation 6 rotates: 40x20 coded → 20x40 decoded, like DecodeBytes.
  const auto rot = ReadFileBytes(FixturePath("exif_orient6_40x20.jpg"));
  opts.maxSide = 4096;
  ASSERT_TRUE(ImageDecoder::ExpectedDecodedSize(rot.data(), rot.size(), opts, &w, &h));
  const auto decoded = ImageDecoder::DecodeBytes(rot.data(), rot.size(), opts);
  ASSERT_TRUE(decoded.ok);
  EXPECT_EQ(w, decoded.frame.width);
  EXPECT_EQ(h, decoded.frame.height);
  // A prefix with the headers is enough.
  ASSERT_TRUE(ImageDecoder::ExpectedDecodedSize(jpg.data(), std::min<size_t>(jpg.size(), 2048),
                                                opts, &w, &h));
  EXPECT_EQ(w, 512);
}

TEST_F(FileLazyFixture, LazyFromBackend_LoaderSlotsDecodeOnDemandWithMeta) {
  auto backend = std::make_shared<ImageFileLazyBackend>(DecodeOptions{});
  int loads = 0;
  const std::vector<std::string> names = {"solid_red_64x48.jpg", "solid_blue_64x48.png"};
  for (const auto& name : names) {
    const auto bytes = ReadFileBytes(FixturePath(name.c_str()));
    int w = 0;
    int h = 0;
    ASSERT_TRUE(ImageDecoder::ExpectedDecodedSize(bytes.data(), bytes.size(), DecodeOptions{}, &w,
                                                  &h));
    backend->AddLoader(
        [bytes, &loads](std::vector<uint8_t>* out, std::string*, std::string*) {
          ++loads;
          *out = bytes;
          return true;
        },
        w, h);
  }
  auto& reg = ImageRegistry::Instance();
  std::vector<ImageRegistry::LazyFrameMeta> meta(2);
  meta[0].href = "p1.jpg";
  meta[0].pageNumber = 1;
  meta[0].sectionIndex = 0;
  meta[1].href = "p2.png";
  meta[1].pageNumber = 2;
  meta[1].sectionIndex = 1;
  auto created =
      reg.CreateLazyFromBackend(backend, meta, ImageThresholdPathType::FileOrigin, 1);
  ASSERT_TRUE(created.ok) << created.errorMessage;
  EXPECT_EQ(created.info.frameCount, 2);
  EXPECT_EQ(loads, 0) << "nothing is read before a frame is needed";

  ImageFrameInfo cold;
  ASSERT_TRUE(reg.GetFrameInfo(created.bufferId, 1, cold));
  EXPECT_EQ(cold.width, 0);
  EXPECT_EQ(cold.expectedWidth, 64);
  EXPECT_EQ(cold.expectedHeight, 48);
  EXPECT_EQ(cold.href, "p2.png");
  EXPECT_EQ(cold.pageNumber, 2);

  auto ensured = reg.EnsureFrame(created.bufferId, 1);
  ASSERT_TRUE(ensured.ok) << ensured.errorMessage;
  EXPECT_EQ(ensured.info.width, 64);
  EXPECT_EQ(ensured.info.href, "p2.png");
  EXPECT_EQ(ensured.info.pageNumber, 2) << "decoding keeps the slot's metadata";
  EXPECT_GE(loads, 1);
  EXPECT_TRUE(reg.EvictFrame(created.bufferId, 1));
  ImageFrameInfo evicted;
  ASSERT_TRUE(reg.GetFrameInfo(created.bufferId, 1, evicted));
  EXPECT_EQ(evicted.width, 0);
  EXPECT_EQ(evicted.expectedWidth, 64);
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(FileLazyFixture, LazyFromBackend_FailingLoaderReportsError) {
  auto backend = std::make_shared<ImageFileLazyBackend>(DecodeOptions{});
  backend->AddLoader(
      [](std::vector<uint8_t>*, std::string* code, std::string* msg) {
        *code = "ERR_DOC_OPEN_FAILED";
        *msg = "gone";
        return false;
      },
      10, 10);
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLazyFromBackend(backend, {}, ImageThresholdPathType::FileOrigin, 2);
  ASSERT_TRUE(created.ok);
  auto ensured = reg.EnsureFrame(created.bufferId, 0);
  EXPECT_FALSE(ensured.ok);
  EXPECT_EQ(ensured.errorCode, "ERR_DOC_OPEN_FAILED");
  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(FileLazyFixture, CreateFromBytes_KnowsExpectedSizes) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateFromBytesList({ReadFileBytes(FixturePath("solid_blue_64x48.png"))},
                                         DecodeOptions{}, ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(created.ok);
  ImageFrameInfo f;
  ASSERT_TRUE(reg.GetFrameInfo(created.bufferId, 0, f));
  EXPECT_EQ(f.width, 0);
  EXPECT_EQ(f.expectedWidth, 64);
  EXPECT_EQ(f.expectedHeight, 48);
  EXPECT_TRUE(reg.Release(created.bufferId));
}
