#include "audio/AudioTimeline.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

TEST(AudioTimeline, IndexAtOrBefore) {
  AudioTimeline t;
  std::vector<AudioPacketEntry> e(4);
  for (int i = 0; i < 4; ++i) {
    e[static_cast<size_t>(i)].ptsUs = i * 21000;
    e[static_cast<size_t>(i)].durationUs = 21000;
  }
  t.AssignImmutable(std::move(e));
  EXPECT_EQ(t.IndexAtOrBefore(-1), -1);
  EXPECT_EQ(t.IndexAtOrBefore(0), 0);
  EXPECT_EQ(t.IndexAtOrBefore(20999), 0);
  EXPECT_EQ(t.IndexAtOrBefore(21000), 1);
  EXPECT_EQ(t.IndexAtOrBefore(100000), 3);
  EXPECT_EQ(t.startUs(), 0);
  EXPECT_EQ(t.endUs(), 4 * 21000);
}

TEST(AudioTimeline, LiveAppendAndEvict) {
  AudioTimeline t;
  for (int i = 0; i < 10; ++i) {
    AudioPacketEntry e;
    e.ptsUs = i * 1000;
    e.durationUs = 1000;
    t.Append(e);
  }
  EXPECT_EQ(t.size(), 10);
  t.EvictBefore(4);
  EXPECT_EQ(t.firstIndex(), 4);
  EXPECT_EQ(t.size(), 6);
  EXPECT_EQ(t.IndexAtOrBefore(3500), -1);
  EXPECT_EQ(t.IndexAtOrBefore(4000), 4);
}
