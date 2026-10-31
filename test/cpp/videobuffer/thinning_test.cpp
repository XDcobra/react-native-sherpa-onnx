#include "decode/ThinningPlanner.h"
#include "synth.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using sherpa_onnx::video::test::FillIpp;

TEST(ThinningPlanner, AllSubmitsRefsPlusSelected) {
  MemoryPacketSource src;
  FillIpp(&src, 30, 15, true);
  std::vector<int64_t> all;
  for (int64_t i = 0; i < src.timeline().frameCount(); ++i) {
    all.push_back(i);
  }
  auto plan = ThinningPlanner::Plan(src.timeline(), all);
  EXPECT_EQ(plan.submitDecodeIndices.size(), 30u);
}

TEST(ThinningPlanner, NonRefSkipWhenNotSelected) {
  MemoryPacketSource src;
  FillIpp(&src, 30, 15, true);
  // Select only even presentation indices.
  std::vector<int64_t> sel;
  for (int64_t i = 0; i < 30; i += 2) {
    sel.push_back(i);
  }
  auto plan = ThinningPlanner::Plan(src.timeline(), sel);
  for (int64_t d : plan.submitDecodeIndices) {
    SampleEntry s;
    const int64_t p = src.timeline().PresentationOfDecode(d);
    ASSERT_TRUE(src.timeline().Get(p, &s).ok);
    if (s.flags & kSampleNonRef) {
      FAIL() << "non-ref " << p << " should not be submitted";
    }
  }
}

TEST(ThinningPlanner, KeyframesOnly) {
  MemoryPacketSource src;
  FillIpp(&src, 45, 15, false);
  std::vector<int64_t> keys = {0, 15, 30};
  auto plan = ThinningPlanner::Plan(src.timeline(), keys);
  EXPECT_EQ(plan.submitDecodeIndices.size(), 3u);
  EXPECT_EQ(plan.submitDecodeIndices[0], 0);
  EXPECT_EQ(plan.submitDecodeIndices[1], 15);
  EXPECT_EQ(plan.submitDecodeIndices[2], 30);
}

TEST(ThinningPlanner, FpsTwoOnThirty) {
  MemoryPacketSource src;
  FillIpp(&src, 30, 15, false);
  // 30 fps, 2 fps → every 15th frame.
  std::vector<int64_t> sel = {0, 15};
  auto plan = ThinningPlanner::Plan(src.timeline(), sel);
  EXPECT_EQ(plan.submitDecodeIndices.size(), 2u);
}

TEST(ThinningPlanner, JumpVsThroughChoosesCheaper) {
  MemoryPacketSource src;
  FillIpp(&src, 45, 15, false);
  // After decoding frame 2, jumping to 30 (next-next key) is cheaper than
  // decoding through 28 ref packets.
  std::vector<int64_t> sel = {2, 30};
  auto plan = ThinningPlanner::Plan(src.timeline(), sel);
  ASSERT_FALSE(plan.seekDecodeIndices.empty());
  EXPECT_EQ(plan.seekDecodeIndices.back(), 30);
}

TEST(ThinningPlanner, UniformCount) {
  MemoryPacketSource src;
  FillIpp(&src, 30, 15, false);
  std::vector<int64_t> sel = {0, 10, 20, 29};
  auto plan = ThinningPlanner::Plan(src.timeline(), sel);
  EXPECT_GE(plan.submitDecodeIndices.size(), sel.size());
}
