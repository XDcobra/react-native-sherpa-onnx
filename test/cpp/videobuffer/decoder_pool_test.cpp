#include "decode/DecoderPool.h"
#include "decode/FakeDecoder.h"

#include <thread>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

class DecoderPoolTest : public ::testing::Test {
 protected:
  void SetUp() override {
    RegisterDecoderFactory([]() {
      return std::unique_ptr<DecoderBackend>(new FakeDecoderBackend());
    });
    DecoderPool::Instance().CloseAll();
    DecoderPool::Instance().SetMaxSessions(DecoderClass::Cpu, 1);
    DecoderPool::Instance().SetMaxSessions(DecoderClass::Display, 1);
    DecoderPool::Instance().SetIdleCloseMs(5000);
  }
  void TearDown() override {
    DecoderPool::Instance().CloseAll();
    ResetDecoderFactoryForTest();
  }
};

TEST_F(DecoderPoolTest, IndependentClassLimits) {
  auto cpu = DecoderPool::Instance().AcquireSlot(DecoderClass::Cpu, "buf_a", 0);
  ASSERT_TRUE(cpu.ok()) << cpu.status.errorMessage;
  auto disp =
      DecoderPool::Instance().AcquireSlot(DecoderClass::Display, "player_a", 0);
  ASSERT_TRUE(disp.ok()) << disp.status.errorMessage;
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 1);
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Display), 1);

  auto cpu2 =
      DecoderPool::Instance().AcquireSlot(DecoderClass::Cpu, "buf_b", 0);
  ASSERT_FALSE(cpu2.ok());
  EXPECT_EQ(cpu2.status.errorCode, kErrDecoderUnavailable);

  auto disp2 = DecoderPool::Instance().AcquireSlot(DecoderClass::Display,
                                                   "player_b", 0);
  ASSERT_FALSE(disp2.ok());
  EXPECT_EQ(disp2.status.errorCode, kErrPreviewDecoderBusy);
  EXPECT_NE(disp2.status.errorMessage.find("player_a"), std::string::npos);
}

TEST_F(DecoderPoolTest, SlotRaIIReleases) {
  {
    auto slot =
        DecoderPool::Instance().AcquireSlot(DecoderClass::Display, "p1", 0);
    ASSERT_TRUE(slot.ok());
    EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Display), 1);
  }
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Display), 0);
  auto again =
      DecoderPool::Instance().AcquireSlot(DecoderClass::Display, "p2", 0);
  ASSERT_TRUE(again.ok()) << again.status.errorMessage;
}

TEST_F(DecoderPoolTest, ReenterSameOwnerIncrementsRefs) {
  auto a = DecoderPool::Instance().AcquireSlot(DecoderClass::Cpu, "same", 0);
  ASSERT_TRUE(a.ok());
  auto b = DecoderPool::Instance().AcquireSlot(DecoderClass::Cpu, "same", 0);
  ASSERT_TRUE(b.ok());
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 1);
  a.value.Reset();
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 1);
  b.value.Reset();
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 0);
}

TEST_F(DecoderPoolTest, IdleCloseSkipsHeldSlots) {
  DecoderPool::Instance().SetIdleCloseMs(0);
  auto held =
      DecoderPool::Instance().AcquireSlot(DecoderClass::Display, "held", 0);
  ASSERT_TRUE(held.ok());
  DecoderPool::Instance().CloseIdle();
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Display), 1);
  EXPECT_TRUE(held.value);
}

TEST_F(DecoderPoolTest, IdleCloseDropsUnheld) {
  DecoderPool::Instance().SetIdleCloseMs(0);
  {
    auto tmp =
        DecoderPool::Instance().AcquireSlot(DecoderClass::Cpu, "tmp", 0);
    ASSERT_TRUE(tmp.ok());
  }
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 0);
  DecoderPool::Instance().CloseIdle();
  EXPECT_EQ(DecoderPool::Instance().activeCount(), 0);
}

TEST_F(DecoderPoolTest, LegacyAcquireUsesCpuClass) {
  auto d = DecoderPool::Instance().Acquire("vid_off_x", 0);
  ASSERT_TRUE(d.ok());
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 1);
  auto other = DecoderPool::Instance().Acquire("vid_off_y", 0);
  ASSERT_FALSE(other.ok());
  DecoderPool::Instance().Release("vid_off_x");
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 0);
}

TEST_F(DecoderPoolTest, CloseUnusedDropsReleasedSlot) {
  auto d = DecoderPool::Instance().Acquire("vid_off_z", 0);
  ASSERT_TRUE(d.ok());
  DecoderPool::Instance().Release("vid_off_z");
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 0);
  EXPECT_GE(DecoderPool::Instance().activeCount(), 1);
  DecoderPool::Instance().CloseUnused(DecoderClass::Cpu, "vid_off_z");
  EXPECT_EQ(DecoderPool::Instance().activeCount(), 0);
}

TEST_F(DecoderPoolTest, CloseUnusedSkipsHeldSlot) {
  auto d = DecoderPool::Instance().Acquire("vid_off_hold", 0);
  ASSERT_TRUE(d.ok());
  DecoderPool::Instance().CloseUnused(DecoderClass::Cpu, "vid_off_hold");
  EXPECT_EQ(DecoderPool::Instance().activeCount(DecoderClass::Cpu), 1);
  DecoderPool::Instance().Release("vid_off_hold");
}

TEST_F(DecoderPoolTest, ConfigureClampsToOneThroughFour) {
  DecoderPool::Instance().SetMaxSessions(DecoderClass::Cpu, 0);
  EXPECT_EQ(DecoderPool::Instance().maxSessions(DecoderClass::Cpu), 1);
  DecoderPool::Instance().SetMaxSessions(DecoderClass::Display, 9);
  EXPECT_EQ(DecoderPool::Instance().maxSessions(DecoderClass::Display), 4);
}

TEST_F(DecoderPoolTest, CpuWaitTimesOut) {
  auto first = DecoderPool::Instance().Acquire("a", 0);
  ASSERT_TRUE(first.ok());
  auto second = DecoderPool::Instance().Acquire("b", 30);
  ASSERT_FALSE(second.ok());
  EXPECT_EQ(second.status.errorCode, kErrDecoderUnavailable);
  DecoderPool::Instance().Release("a");
}
