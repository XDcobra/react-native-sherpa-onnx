#include "sortformer-post-processor.h"

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

namespace sherpaonnx::diarization {

TEST(SortformerPostProcessorTest, MedianFilterSmoothsImpulseNoise) {
  SortformerPostProcessorConfig cfg;
  cfg.median_window = 3;
  SortformerPostProcessor proc(cfg);

  // 1 speaker, 5 frames: [0, 0, 1, 0, 0] -> single spike should be removed by median 3
  std::vector<float> preds = {0.0f, 0.0f, 1.0f, 0.0f, 0.0f};
  std::vector<float> filtered(5);

  proc.ApplyMedianFilter(preds.data(), 5, 1, filtered.data());

  EXPECT_FLOAT_EQ(filtered[2], 0.0f);
}

TEST(SortformerPostProcessorTest, BinarizeDetectsSegmentsWithAccurateTimes) {
  SortformerPostProcessorConfig cfg;
  cfg.onset = 0.5f;
  cfg.offset = 0.5f;
  cfg.sample_rate = 16000;
  cfg.frame_duration = 0.08f; // 80ms -> 1280 samples per frame
  cfg.min_duration_on = 0.05f;
  cfg.min_duration_off = 0.0f;
  cfg.median_window = 1;

  SortformerPostProcessor proc(cfg);

  // 2 speakers, 4 frames
  // Spk 0 active on frame 1 and 2
  // Spk 1 active on frame 3
  std::vector<float> preds = {
    // Spk 0, Spk 1
    0.1f, 0.1f, // frame 0
    0.9f, 0.1f, // frame 1
    0.9f, 0.1f, // frame 2
    0.1f, 0.9f, // frame 3
  };

  std::vector<DiarizationSegment> segs;
  proc.Process(preds.data(), 4, 2, 0, 0, segs);

  ASSERT_EQ(segs.size(), 2u);

  // Speaker 0 should be first (frame 1 to 3 -> 0.08s to 0.24s)
  EXPECT_EQ(segs[0].speaker, 0);
  EXPECT_NEAR(segs[0].start, 0.08f, 1e-4f);
  EXPECT_NEAR(segs[0].end, 0.24f, 1e-4f);

  // Speaker 1 should be second (frame 3 to 4 -> 0.24s to 0.32s)
  EXPECT_EQ(segs[1].speaker, 1);
  EXPECT_NEAR(segs[1].start, 0.24f, 1e-4f);
  EXPECT_NEAR(segs[1].end, 0.32f, 1e-4f);
}

TEST(SortformerPostProcessorTest, MergesCloseSegmentsWithinMinDurationOff) {
  SortformerPostProcessorConfig cfg;
  cfg.onset = 0.5f;
  cfg.offset = 0.5f;
  cfg.sample_rate = 16000;
  cfg.frame_duration = 0.08f;
  cfg.min_duration_on = 0.05f;
  cfg.min_duration_off = 0.2f; // Merge gap <= 200ms
  cfg.median_window = 1;

  SortformerPostProcessor proc(cfg);

  // Speaker 0 active at frame 0, inactive frame 1 (80ms gap), active frame 2
  std::vector<float> preds = {
    0.9f, // frame 0: active
    0.1f, // frame 1: gap (80ms <= 200ms)
    0.9f, // frame 2: active
  };

  std::vector<DiarizationSegment> segs;
  proc.Process(preds.data(), 3, 1, 0, 0, segs);

  // Should be merged into a single segment spanning 0 to 3 frames (0 to 0.24s)
  ASSERT_EQ(segs.size(), 1u);
  EXPECT_EQ(segs[0].speaker, 0);
  EXPECT_NEAR(segs[0].start, 0.0f, 1e-4f);
  EXPECT_NEAR(segs[0].end, 0.24f, 1e-4f);
}

} // namespace sherpaonnx::diarization
