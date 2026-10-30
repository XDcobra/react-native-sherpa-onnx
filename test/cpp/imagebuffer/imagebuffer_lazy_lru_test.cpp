#include "ImageRegistry.h"
#include "PdfLazyBackend.h"
#include "image_test_utils.h"

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <vector>

using namespace sherpa_onnx::image;
using sherpa_onnx::image::testutil::MakeSolidRgb;
using sherpa_onnx::image::testutil::MakeTempCacheDir;
using sherpa_onnx::image::testutil::RemoveDirRecursive;

namespace {

class FakePdfLazyBackend final : public sherpa_onnx::pdf::PdfLazyBackend {
 public:
  FakePdfLazyBackend(int page_count, int dpi, int max_side)
      : page_count_(page_count), dpi_(dpi), max_side_(max_side) {}

  int page_count() const override { return page_count_; }
  int dpi() const override { return dpi_; }
  int max_side() const override { return max_side_; }

  bool RasterizePage(int page_1based, RgbFrame* out, std::string* err_code,
                     std::string* err_message) override {
    if (!out) {
      if (err_code) *err_code = "ERR_PDF_INVALID_ARGUMENT";
      if (err_message) *err_message = "out required";
      return false;
    }
    if (page_1based < 1 || page_1based > page_count_) {
      if (err_code) *err_code = "ERR_PDF_INVALID_ARGUMENT";
      if (err_message) *err_message = "page out of range";
      return false;
    }
    // Distinct size per page so eviction/hot checks are obvious.
    const int w = 8 + page_1based;
    const int h = 6 + page_1based;
    *out = MakeSolidRgb(w, h, static_cast<uint8_t>(page_1based * 40), 20, 30);
    out->pageNumber = page_1based;
    out->dpi = dpi_;
    return true;
  }

 private:
  int page_count_ = 0;
  int dpi_ = 144;
  int max_side_ = 4096;
};

class LazyLruFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = MakeTempCacheDir("imgbuf_lazy");
    auto& reg = ImageRegistry::Instance();
    reg.SetCacheDir(cacheDir_);
    reg.ConfigureThreshold(ImageThresholdPlatform::Android,
                           4ULL * 1024ULL * 1024ULL * 1024ULL);
  }

  void TearDown() override { RemoveDirRecursive(cacheDir_); }

  static int CountHot(const std::string& bufferId, int frameCount) {
    auto& reg = ImageRegistry::Instance();
    int hot = 0;
    for (int i = 0; i < frameCount; ++i) {
      ImageFrameInfo info;
      if (!reg.GetFrameInfo(bufferId, i, info)) continue;
      if (info.width > 0 && info.height > 0) ++hot;
    }
    return hot;
  }

  std::string cacheDir_;
};

}  // namespace

TEST_F(LazyLruFixture, CreateLazySlots_ColdPlaceholders) {
  auto& reg = ImageRegistry::Instance();
  auto backend = std::make_unique<FakePdfLazyBackend>(5, 144, 2048);
  auto created = reg.CreateLazyPdfSlots(std::move(backend), {}, 2);
  ASSERT_TRUE(created.ok) << created.errorMessage;
  EXPECT_EQ(created.info.state, ImageBufferState::Lazy);
  EXPECT_EQ(created.info.frameCount, 5);
  EXPECT_EQ(created.info.totalBytes, 0);

  for (int i = 0; i < 5; ++i) {
    ImageFrameInfo f;
    ASSERT_TRUE(reg.GetFrameInfo(created.bufferId, i, f));
    EXPECT_EQ(f.width, 0);
    EXPECT_EQ(f.height, 0);
    EXPECT_EQ(f.pageNumber, i + 1);
    EXPECT_EQ(f.dpi, 144);
  }

  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LazyLruFixture, Ensure_HotFramesLimitAndEvictKeepsMetadata) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLazyPdfSlots(
      std::make_unique<FakePdfLazyBackend>(5, 72, 1024), {}, 2);
  ASSERT_TRUE(created.ok) << created.errorMessage;
  const std::string id = created.bufferId;

  for (int i = 0; i < 5; ++i) {
    auto ensured = reg.EnsureFrame(id, i);
    ASSERT_TRUE(ensured.ok) << ensured.errorMessage;
    EXPECT_GT(ensured.info.width, 0);
    EXPECT_EQ(ensured.info.pageNumber, i + 1);
    EXPECT_LE(CountHot(id, 5), 2);
  }

  EXPECT_EQ(CountHot(id, 5), 2);

  // Cold frames keep pageNumber/dpi after eviction.
  for (int i = 0; i < 5; ++i) {
    ImageFrameInfo f;
    ASSERT_TRUE(reg.GetFrameInfo(id, i, f));
    EXPECT_EQ(f.pageNumber, i + 1);
    EXPECT_EQ(f.dpi, 72);
  }

  EXPECT_TRUE(reg.Release(id));
}

TEST_F(LazyLruFixture, GetFrameRgbPtr_EnsuresColdFrame) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLazyPdfSlots(
      std::make_unique<FakePdfLazyBackend>(3, 144, 4096), {}, 8);
  ASSERT_TRUE(created.ok);

  int w = 0;
  int h = 0;
  const uint8_t* ptr = reg.GetFrameRgbPtr(created.bufferId, 1, &w, &h);
  ASSERT_NE(ptr, nullptr);
  EXPECT_EQ(w, 8 + 2);
  EXPECT_EQ(h, 6 + 2);

  ImageFrameInfo f;
  ASSERT_TRUE(reg.GetFrameInfo(created.bufferId, 1, f));
  EXPECT_EQ(f.width, w);
  EXPECT_EQ(f.height, h);

  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LazyLruFixture, Ensure_ImmutableIsNoOp) {
  auto& reg = ImageRegistry::Instance();
  RgbFrame a = MakeSolidRgb(4, 4, 1, 2, 3);
  a.pageNumber = 1;
  a.dpi = 96;
  auto created = reg.CreateFromRgbFrames({std::move(a)},
                                         ImageThresholdPathType::HeapOrigin);
  ASSERT_TRUE(created.ok);
  EXPECT_EQ(created.info.state, ImageBufferState::Immutable);

  auto ensured = reg.EnsureFrame(created.bufferId, 0);
  ASSERT_TRUE(ensured.ok);
  EXPECT_EQ(ensured.info.width, 4);
  EXPECT_EQ(ensured.info.height, 4);

  EXPECT_TRUE(reg.Release(created.bufferId));
}

TEST_F(LazyLruFixture, Release_InvalidatesEnsure) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLazyPdfSlots(
      std::make_unique<FakePdfLazyBackend>(2, 144, 4096), {}, 2);
  ASSERT_TRUE(created.ok);
  const std::string id = created.bufferId;
  ASSERT_TRUE(reg.EnsureFrame(id, 0).ok);
  EXPECT_TRUE(reg.Release(id));

  ImageBufferInfo info;
  EXPECT_FALSE(reg.GetInfo(id, info));
  auto ensured = reg.EnsureFrame(id, 0);
  EXPECT_FALSE(ensured.ok);
}

TEST_F(LazyLruFixture, EvictFrame_DropsRgbKeepsMetadata) {
  auto& reg = ImageRegistry::Instance();
  auto created = reg.CreateLazyPdfSlots(
      std::make_unique<FakePdfLazyBackend>(2, 200, 4096), {}, 2);
  ASSERT_TRUE(created.ok);
  ASSERT_TRUE(reg.EnsureFrame(created.bufferId, 0).ok);

  EXPECT_TRUE(reg.EvictFrame(created.bufferId, 0));
  ImageFrameInfo f;
  ASSERT_TRUE(reg.GetFrameInfo(created.bufferId, 0, f));
  EXPECT_EQ(f.width, 0);
  EXPECT_EQ(f.height, 0);
  EXPECT_EQ(f.pageNumber, 1);
  EXPECT_EQ(f.dpi, 200);

  EXPECT_TRUE(reg.Release(created.bufferId));
}
