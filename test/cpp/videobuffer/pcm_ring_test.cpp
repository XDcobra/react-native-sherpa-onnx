#include "preview/PcmRing.h"

#include <atomic>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video::preview;

TEST(PcmRing, WrapFullEmpty) {
  PcmRing ring;
  ring.Configure(48000, 2, 20);
  EXPECT_GT(ring.availableWrite(), 0);
  EXPECT_EQ(ring.availableRead(), 0);
  std::vector<float> in(256, 0.5f);
  ASSERT_TRUE(ring.Write(in.data(), 128, 0));
  EXPECT_EQ(ring.availableRead(), 128);
  std::vector<float> out(256, 0);
  int64_t pts = -1;
  EXPECT_EQ(ring.Read(out.data(), 128, &pts), 128);
  EXPECT_EQ(pts, 0);
  EXPECT_EQ(ring.availableRead(), 0);
}

TEST(PcmRing, PtsAdvances) {
  PcmRing ring;
  ring.Configure(1000, 1, 100);
  float x[10] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
  ASSERT_TRUE(ring.Write(x, 10, 0));
  float y[10];
  int64_t pts = 0;
  ring.Read(y, 10, &pts);
  EXPECT_EQ(pts, 0);
  ASSERT_TRUE(ring.Write(x, 10, 10000));
  ring.Read(y, 5, &pts);
  EXPECT_GE(pts, 10000);
}

TEST(PcmRing, SpscStress) {
  PcmRing ring;
  ring.Configure(48000, 1, 50);
  std::atomic<bool> done{false};
  std::thread w([&] {
    float x[64] = {};
    int64_t pts = 0;
    for (int i = 0; i < 200; ++i) {
      while (!ring.Write(x, 32, pts)) {
        std::this_thread::yield();
      }
      pts += 666;
    }
    done = true;
  });
  float y[64];
  int got = 0;
  while (!done || ring.availableRead() > 0) {
    int64_t pts = 0;
    got += ring.Read(y, 32, &pts);
    std::this_thread::yield();
  }
  w.join();
  EXPECT_GT(got, 0);
}
