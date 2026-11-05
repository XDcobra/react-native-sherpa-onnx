/**
 * Host tests for ByteBufferPool — no JSI / no device.
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #17).
 */
#include "ByteBufferPool.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <vector>

using sherpaonnx::ByteBufferPool;

class ByteBufferPoolFixture : public ::testing::Test {
 protected:
  void SetUp() override { ByteBufferPool::instance().clearForTesting(); }
  void TearDown() override { ByteBufferPool::instance().clearForTesting(); }
};

TEST_F(ByteBufferPoolFixture, SizeClass_RoundsToPow2WithFloor) {
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(0), 0u);
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(1), ByteBufferPool::kMinClassBytes);
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(100), ByteBufferPool::kMinClassBytes);
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(ByteBufferPool::kMinClassBytes),
            ByteBufferPool::kMinClassBytes);
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(ByteBufferPool::kMinClassBytes + 1),
            ByteBufferPool::kMinClassBytes * 2);
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(ByteBufferPool::kMaxClassBytes),
            ByteBufferPool::kMaxClassBytes);
  EXPECT_EQ(ByteBufferPool::sizeClassBytes(ByteBufferPool::kMaxClassBytes + 1), 0u);
}

TEST_F(ByteBufferPoolFixture, AcquireRelease_ReusesCapacity) {
  auto &pool = ByteBufferPool::instance();
  const size_t n = 1024;
  auto first = pool.acquire(n);
  ASSERT_EQ(first.size(), n);
  ASSERT_GE(first.capacity(), ByteBufferPool::kMinClassBytes);
  const size_t cap = first.capacity();
  uint8_t *ptr = first.data();
  first[0] = 0xAB;

  pool.release(std::move(first));
  EXPECT_EQ(pool.freelistDepthFor(n), 1u);

  auto second = pool.acquire(n);
  EXPECT_EQ(second.size(), n);
  EXPECT_EQ(second.capacity(), cap);
  EXPECT_EQ(second.data(), ptr);
  EXPECT_EQ(pool.freelistDepthFor(n), 0u);

  pool.release(std::move(second));
}

TEST_F(ByteBufferPoolFixture, ZeroSize_NoPoolEntry) {
  auto &pool = ByteBufferPool::instance();
  auto empty = pool.acquire(0);
  EXPECT_TRUE(empty.empty());
  EXPECT_EQ(empty.capacity(), 0u);
  pool.release(std::move(empty));
  EXPECT_EQ(pool.freelistDepthFor(1), 0u);
}

TEST_F(ByteBufferPoolFixture, Oversize_NotPooled) {
  auto &pool = ByteBufferPool::instance();
  const size_t big = ByteBufferPool::kMaxClassBytes + 64;
  auto v = pool.acquire(big);
  ASSERT_EQ(v.size(), big);
  pool.release(std::move(v));
  EXPECT_EQ(pool.freelistDepthFor(big), 0u);
  EXPECT_EQ(pool.freelistDepthFor(ByteBufferPool::kMaxClassBytes), 0u);
}

TEST_F(ByteBufferPoolFixture, FreelistDepth_Capped) {
  auto &pool = ByteBufferPool::instance();
  const size_t n = 512;
  std::vector<std::vector<uint8_t>> held;
  // Acquire more than max, release all — freelist must cap.
  for (size_t i = 0; i < ByteBufferPool::kMaxPerClass + 4; ++i) {
    held.push_back(pool.acquire(n));
  }
  for (auto &v : held) {
    pool.release(std::move(v));
  }
  EXPECT_EQ(pool.freelistDepthFor(n), ByteBufferPool::kMaxPerClass);
}

// After warm freelist, steady acquire/release should be 100% hits.
// Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #17).
TEST_F(ByteBufferPoolFixture, HitRate_SteadyReuse) {
  auto &pool = ByteBufferPool::instance();
  const size_t n = 320 * sizeof(float);  // typical JSI float chunk
  std::vector<uint8_t> warm = pool.acquire(n);
  pool.release(std::move(warm));
  pool.resetStats();

  constexpr int kIters = 200;
  for (int i = 0; i < kIters; ++i) {
    auto v = pool.acquire(n);
    ASSERT_EQ(v.size(), n);
    pool.release(std::move(v));
  }
  auto st = pool.stats();
  EXPECT_EQ(st.acquires, static_cast<uint64_t>(kIters));
  EXPECT_EQ(st.hits, static_cast<uint64_t>(kIters));
  EXPECT_EQ(st.misses, 0u);
  EXPECT_GT(st.releases_pooled, 0u);
}
