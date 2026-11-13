#include "sortformer-post-processor.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <vector>

using sherpaonnx::diarization::DiarizationSegment;
using sherpaonnx::diarization::SortformerPostProcessor;
using sherpaonnx::diarization::SortformerPostProcessorConfig;

namespace {

// Mirrors DetectPredUpsample in sortformer-streaming-model.cpp
int32_t DetectPredUpsample(int64_t pred_T, int32_t old_spkcache_len,
                           int32_t old_fifo_len, int32_t valid_frames,
                           int32_t current_len, int32_t subsampling) {
  const int32_t encoder_total =
      old_spkcache_len + old_fifo_len + valid_frames;
  const int32_t highres_total =
      (old_spkcache_len + old_fifo_len) * subsampling + current_len;
  if (pred_T <= 0) {
    return 1;
  }
  if (highres_total > encoder_total + 1 &&
      std::llabs(pred_T - highres_total) <= 1) {
    return std::max(1, subsampling);
  }
  if (std::llabs(pred_T - encoder_total) <= 1) {
    return 1;
  }
  if (pred_T >= static_cast<int64_t>(encoder_total) * 2) {
    return std::max(1, subsampling);
  }
  return 1;
}

}  // namespace

TEST(SortformerPredUpsampleTest, DetectsHighResNemotronShapes) {
  // chunk_len=6, right_context=2 → mel=64, valid=8; empty caches
  EXPECT_EQ(DetectPredUpsample(/*pred_T=*/64, 0, 0, 8, 64, 8), 8);
  // warm: spk=10, fifo=5 → highres=(10+5)*8+64=184
  EXPECT_EQ(DetectPredUpsample(/*pred_T=*/184, 10, 5, 8, 64, 8), 8);
}

TEST(SortformerPredUpsampleTest, DetectsEncoderRateSortformerShapes) {
  // Classic Sortformer: preds length == encoder frames
  EXPECT_EQ(DetectPredUpsample(/*pred_T=*/8, 0, 0, 8, 64, 8), 1);
  EXPECT_EQ(DetectPredUpsample(/*pred_T=*/23, 10, 5, 8, 64, 8), 1);
}

TEST(SortformerPredUpsampleTest, HighResFrameDurationMatchesTenMs) {
  SortformerPostProcessorConfig cfg;
  cfg.sample_rate = 16000;
  cfg.frame_duration = 0.08f;
  SortformerPostProcessor proc(cfg);
  proc.SetFrameDuration(0.01f);

  // 100 frames @ 10ms = 1.0s of audio starting at sample 0
  std::vector<float> preds(100 * 1, 0.9f);
  std::vector<sherpaonnx::diarization::DiarizationSegment> segs;
  proc.Process(preds.data(), 100, 1, /*sample_offset=*/0,
               /*max_sample_bound=*/16000, segs);
  ASSERT_FALSE(segs.empty());
  EXPECT_NEAR(segs.front().start, 0.0f, 1e-3f);
  EXPECT_NEAR(segs.front().end, 1.0f, 2e-2f);
}
