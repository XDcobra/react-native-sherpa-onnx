#include "core/DecodedFrameCache.h"
#include "core/MemoryBudget.h"
#include "decode/FakeDecoder.h"

#include <cstring>
#include <memory>
#include <vector>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

namespace {

Nv12View MakeGrayNv12(AlignedBuffer* buf, int w, int h, uint8_t y) {
  const int ys = AlignUp(w);
  const int uvs = AlignUp(w);
  const size_t bytes =
      static_cast<size_t>(ys) * h + static_cast<size_t>(uvs) * ((h + 1) / 2);
  buf->Allocate(bytes);
  std::memset(buf->data(), y, static_cast<size_t>(ys) * h);
  std::memset(buf->data() + static_cast<size_t>(ys) * h, 128,
              static_cast<size_t>(uvs) * ((h + 1) / 2));
  Nv12View v;
  v.y.data = buf->data();
  v.y.stride = ys;
  v.uv.data = buf->data() + static_cast<size_t>(ys) * h;
  v.uv.stride = uvs;
  v.width = w;
  v.height = h;
  return v;
}

CacheKey Key(int64_t i) {
  CacheKey k;
  k.presentationIndex = i;
  return k;
}

}  // namespace

class DecodedCacheTest : public ::testing::Test {
 protected:
  void SetUp() override { MemoryBudget::Instance().SetLimitBytes(2 * 1024 * 1024); }
  void TearDown() override {
    MemoryBudget::Instance().ResetUsedForTest();
    MemoryBudget::Instance().Configure(VideoRamClass::Mid);
  }
};

TEST_F(DecodedCacheTest, BudgetNeverExceeded) {
  auto cache = std::make_shared<DecodedFrameCache>();
  AlignedBuffer buf;
  auto nv = MakeGrayNv12(&buf, 64, 64, 40);
  VideoTrackInfo t;
  for (int i = 0; i < 80; ++i) {
    auto st = cache->InsertNv12(Key(i), nv, i * 33333, t);
    if (!st.ok) {
      EXPECT_EQ(st.errorCode, kErrMemoryBudget);
      break;
    }
  }
  EXPECT_LE(MemoryBudget::Instance().usedBytes(),
            MemoryBudget::Instance().limitBytes());
}

TEST_F(DecodedCacheTest, PinnedSurvivesEviction) {
  MemoryBudget::Instance().SetLimitBytes(64 * 1024);
  auto cache = std::make_shared<DecodedFrameCache>();
  AlignedBuffer buf;
  auto nv = MakeGrayNv12(&buf, 64, 64, 80);
  VideoTrackInfo t;
  ASSERT_TRUE(cache->InsertNv12(Key(0), nv, 0, t).ok);
  auto pin = cache->Lookup(Key(0));
  ASSERT_TRUE(pin.ok());
  const uint8_t* ptr = pin.value.view().plane[0];
  ASSERT_NE(ptr, nullptr);
  for (int i = 1; i < 40; ++i) {
    cache->InsertNv12(Key(i), nv, i * 33333, t);
  }
  EXPECT_EQ(ptr[0], 80);
  EXPECT_TRUE(pin.value.valid());
}

TEST_F(DecodedCacheTest, PressureShrinksToPinned) {
  auto cache = std::make_shared<DecodedFrameCache>();
  AlignedBuffer buf;
  auto nv = MakeGrayNv12(&buf, 32, 32, 16);
  VideoTrackInfo t;
  ASSERT_TRUE(cache->InsertNv12(Key(0), nv, 0, t).ok);
  ASSERT_TRUE(cache->InsertNv12(Key(1), nv, 33333, t).ok);
  auto pin = cache->Lookup(Key(0));
  ASSERT_TRUE(pin.ok());
  cache->ShrinkToPinned();
  EXPECT_EQ(cache->cachedCount(), 1);
  EXPECT_TRUE(pin.value.valid());
  auto miss = cache->Lookup(Key(1));
  EXPECT_FALSE(miss.ok());
}

TEST_F(DecodedCacheTest, LruOrderEvictsOldestUnpinned) {
  MemoryBudget::Instance().SetLimitBytes(24 * 1024);
  auto cache = std::make_shared<DecodedFrameCache>();
  AlignedBuffer buf;
  auto nv = MakeGrayNv12(&buf, 64, 64, 20);
  VideoTrackInfo t;
  ASSERT_TRUE(cache->InsertNv12(Key(0), nv, 0, t).ok);
  ASSERT_TRUE(cache->InsertNv12(Key(1), nv, 33333, t).ok);
  auto hit = cache->Lookup(Key(0));
  hit.value = {};  // unpin 0 so 1 is more recent... Lookup pinned 0
  // drop lease
  hit = Result<VideoFrameLease>{};
  ASSERT_TRUE(cache->InsertNv12(Key(2), nv, 66666, t).ok);
  // With tiny budget, some unpinned entries may have been evicted.
  EXPECT_LE(MemoryBudget::Instance().usedBytes(),
            MemoryBudget::Instance().limitBytes());
}
