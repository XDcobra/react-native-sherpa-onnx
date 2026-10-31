#include "preview/FrameScheduler.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video::preview;

TEST(FrameScheduler, DropWhenLate) {
  auto r = FrameScheduler::Decide(0, 80'000, 1'000'000'000, 16'666'666, 33333);
  EXPECT_EQ(r.decision, FrameDecision::Drop);
}

TEST(FrameScheduler, WaitWhenEarly) {
  auto r = FrameScheduler::Decide(80'000, 0, 1'000'000'000, 16'666'666, 33333);
  EXPECT_EQ(r.decision, FrameDecision::Wait);
}

TEST(FrameScheduler, ReleaseOnTime) {
  auto r = FrameScheduler::Decide(1000, 0, 1'000'000'000, 16'666'666, 33333);
  EXPECT_EQ(r.decision, FrameDecision::Release);
}

TEST(FrameScheduler, Hz60Vs120) {
  auto a = FrameScheduler::Decide(40'000, 0, 0, 16'666'666, 16666);
  auto b = FrameScheduler::Decide(40'000, 0, 0, 8'333'333, 8333);
  EXPECT_EQ(a.decision, FrameDecision::Wait);
  EXPECT_EQ(b.decision, FrameDecision::Wait);
}

TEST(FrameScheduler, ClockJumpDrops) {
  auto r = FrameScheduler::Decide(0, 1'000'000, 0, 16'666'666, 33333);
  EXPECT_EQ(r.decision, FrameDecision::Drop);
}
