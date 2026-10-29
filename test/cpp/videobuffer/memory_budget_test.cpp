#include "core/MemoryBudget.h"

#include <gtest/gtest.h>

using sherpa_onnx::video::MemoryBudget;
using sherpa_onnx::video::VideoRamClass;

TEST(MemoryBudget, TinyLimitRejects) {
  auto& b = MemoryBudget::Instance();
  b.SetLimitBytes(2 * 1024 * 1024);
  EXPECT_TRUE(b.TryReserve(1024 * 1024));
  EXPECT_FALSE(b.TryReserve(2 * 1024 * 1024));
  b.Release(1024 * 1024);
  EXPECT_EQ(b.usedBytes(), 0);
  b.Configure(VideoRamClass::Mid);
}

TEST(MemoryBudget, ClassifyRam) {
  EXPECT_EQ(MemoryBudget::ClassifyRam(2ull << 30), VideoRamClass::Low);
  EXPECT_EQ(MemoryBudget::ClassifyRam(4ull << 30), VideoRamClass::Mid);
  EXPECT_EQ(MemoryBudget::ClassifyRam(8ull << 30), VideoRamClass::High);
  EXPECT_EQ(MemoryBudget::ClassifyRam(16ull << 30), VideoRamClass::VeryHigh);
}
