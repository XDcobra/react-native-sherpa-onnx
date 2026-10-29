#include "core/Timeline.h"

#include <gtest/gtest.h>

using sherpa_onnx::video::kSampleKey;
using sherpa_onnx::video::kSampleNonRef;
using sherpa_onnx::video::SampleEntry;
using sherpa_onnx::video::Timeline;

namespace {

SampleEntry Make(int64_t pts, int64_t dts, uint32_t flags) {
  SampleEntry s;
  s.ptsUs = pts;
  s.dtsUs = dts;
  s.flags = flags;
  s.size = 10;
  return s;
}

void CfrGop(Timeline* t, int frames, int gop, int64_t durUs) {
  std::vector<SampleEntry> v;
  v.reserve(static_cast<size_t>(frames));
  for (int i = 0; i < frames; ++i) {
    uint32_t f = (i % gop == 0) ? kSampleKey : 0;
    v.push_back(Make(i * durUs, i * durUs, f));
  }
  t->AssignImmutable(std::move(v));
}

}  // namespace

TEST(Timeline, SampleAtPtsBoundaries) {
  Timeline t;
  CfrGop(&t, 10, 5, 33333);
  EXPECT_EQ(t.SampleAtPts(0), 0);
  EXPECT_EQ(t.SampleAtPts(33332), 0);
  EXPECT_EQ(t.SampleAtPts(33333), 1);
  EXPECT_EQ(t.SampleAtPts(9 * 33333), 9);
  EXPECT_EQ(t.SampleAtPts(9 * 33333 + 1000), 9);
}

TEST(Timeline, KeyframeAtOrBefore) {
  Timeline t;
  CfrGop(&t, 12, 4, 1000);
  EXPECT_EQ(t.KeyframeAtOrBefore(0), 0);
  EXPECT_EQ(t.KeyframeAtOrBefore(3), 0);
  EXPECT_EQ(t.KeyframeAtOrBefore(4), 4);
  EXPECT_EQ(t.KeyframeAtOrBefore(11), 8);
}

TEST(Timeline, ClosestKeyframe) {
  Timeline t;
  CfrGop(&t, 12, 4, 1000);
  EXPECT_EQ(t.ClosestKeyframe(0), 0);
  EXPECT_EQ(t.ClosestKeyframe(1500), 0);   // closer to 0 than 4000
  EXPECT_EQ(t.ClosestKeyframe(3500), 4);
}

TEST(Timeline, VfrAndBframesPtsNeqDts) {
  Timeline t;
  // Presentation order: I (pts0) , B (pts1000, dts2000), P (pts2000, dts1000)
  std::vector<SampleEntry> v;
  v.push_back(Make(0, 0, kSampleKey));
  v.push_back(Make(1000, 2000, 0));
  v.push_back(Make(2000, 1000, 0));
  t.AssignImmutable(std::move(v));
  EXPECT_EQ(t.SampleAtPts(1000), 1);
  EXPECT_EQ(t.SampleAtPts(1500), 1);
  EXPECT_EQ(t.DecodeIndexOf(2), 1);  // P decoded before B
  EXPECT_EQ(t.DecodeIndexOf(1), 2);
}

TEST(Timeline, OutOfRange) {
  Timeline t;
  CfrGop(&t, 2, 2, 1000);
  SampleEntry s;
  EXPECT_FALSE(t.Get(-1, &s).ok);
  EXPECT_FALSE(t.Get(2, &s).ok);
}

TEST(Timeline, KeyframeTimes) {
  Timeline t;
  CfrGop(&t, 10, 5, 1000);
  auto times = t.KeyframeTimes(0, 100000, 8);
  ASSERT_EQ(times.size(), 2u);
  EXPECT_EQ(times[0], 0);
  EXPECT_EQ(times[1], 5000);
}

TEST(Timeline, LiveAppendChunked) {
  Timeline t;
  for (int i = 0; i < 2000; ++i) {
    t.Append(Make(i * 1000, i * 1000, i % 30 == 0 ? kSampleKey : 0));
  }
  EXPECT_EQ(t.frameCount(), 2000);
  EXPECT_EQ(t.KeyframeAtOrBefore(1999) % 30, 0);
}

TEST(Timeline, EditListOffset) {
  Timeline t;
  std::vector<SampleEntry> v;
  v.push_back(Make(100000, 100000, kSampleKey));
  v.push_back(Make(133333, 133333, 0));
  t.AssignImmutable(std::move(v));
  EXPECT_EQ(t.startUs(), 100000);
  EXPECT_EQ(t.SampleAtPts(100000), 0);
  EXPECT_EQ(t.SampleAtPts(120000), 0);
}
