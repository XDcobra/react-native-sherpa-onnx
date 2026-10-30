#include "preview/PlaybackClock.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video::preview;

TEST(Clock, PauseFlushSegmentReset) {
  MonotonicClock c;
  c.SetNowNsForTest(1'000'000'000);
  c.SetRate(1, 0);
  c.SetNowNsForTest(1'100'000'000);
  EXPECT_NEAR(c.NowMediaUs(), 100000, 1);
  c.SetRate(0, 100000);
  c.SetNowNsForTest(2'000'000'000);
  EXPECT_EQ(c.NowMediaUs(), 100000);
}

TEST(Clock, HeadThenTimestamp) {
  AudioClockEstimator e;
  e.sampleRate = 48000;
  e.rate = 1;
  e.ResetSegment(0, 0);
  e.framesWritten = 4800;
  e.OnHead(2400);
  int64_t corr = 0;
  int64_t m = e.Media(0, &corr);
  EXPECT_GT(m, 0);
  e.OnTimestamp(2400, 2'000'000'000);
  m = e.Media(2'000'000'000, &corr);
  EXPECT_NEAR(m, 50000, 1);
}

TEST(Clock, NeverAheadOfWritten) {
  AudioClockEstimator e;
  e.sampleRate = 48000;
  e.rate = 1;
  e.ResetSegment(0, 0);
  e.framesWritten = 480;
  e.OnTimestamp(48000, 1);
  bool snapped = false;
  int64_t cand = e.Media(1);
  int64_t g = e.ApplyGuards(cand, 1, &snapped);
  EXPECT_LE(g, 10000);
}

TEST(Clock, SlewVsSnap) {
  AudioClockEstimator e;
  e.sampleRate = 48000;
  e.rate = 1;
  e.ResetSegment(0, 0);
  e.framesWritten = 480000;
  e.lastMediaUs = 0;
  bool snapped = false;
  int64_t g = e.ApplyGuards(4000, 0, &snapped);
  EXPECT_FALSE(snapped);
  EXPECT_EQ(g, 4000);
  g = e.ApplyGuards(200000, 0, &snapped);
  EXPECT_TRUE(snapped);
}

TEST(Clock, MonotonicWhilePlaying) {
  AudioClockEstimator e;
  e.sampleRate = 48000;
  e.rate = 1;
  e.ResetSegment(0, 0);
  e.framesWritten = 48000;
  e.lastMediaUs = 1000;
  bool snapped = false;
  int64_t g = e.ApplyGuards(500, 0, &snapped);
  EXPECT_GE(g, 1000);
}
