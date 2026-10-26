#include <gtest/gtest.h>

#include "OcrOrtEnv.h"
#include "OcrRecognizeContext.h"

#include <string>
#include <utility>
#include <vector>

using sherpa_onnx::ocr::OcrCancelled;
using sherpa_onnx::ocr::OcrProgressTick;
using sherpa_onnx::ocr::OcrRecognizeContext;
using sherpa_onnx::ocr::kOcrPhaseDecode;
using sherpa_onnx::ocr::kOcrPhaseVision;

TEST(OcrRecognizeContext, ReportNoOpWithoutCallback) {
  OcrRecognizeContext ctx;
  EXPECT_NO_THROW(ctx.Report(kOcrPhaseVision, 0, 1));
  EXPECT_NO_THROW(ctx.ThrowIfCancelled());
}

TEST(OcrRecognizeContext, ReportFillsFrameAndPhase) {
  std::vector<OcrProgressTick> ticks;
  OcrRecognizeContext ctx;
  ctx.frame_index = 2;
  ctx.frame_count = 5;
  ctx.progress = [&](const OcrProgressTick& tick) { ticks.push_back(tick); };

  ctx.Report("custom_phase", 3, 10);
  ASSERT_EQ(ticks.size(), 1u);
  EXPECT_EQ(ticks[0].phase, "custom_phase");
  EXPECT_EQ(ticks[0].done, 3);
  EXPECT_EQ(ticks[0].total, 10);
  EXPECT_EQ(ticks[0].frame_index, 2);
  EXPECT_EQ(ticks[0].frame_count, 5);
}

TEST(OcrRecognizeContext, ThrowIfCancelled) {
  OcrRecognizeContext ctx;
  ctx.cancel = []() { return true; };
  EXPECT_THROW(ctx.ThrowIfCancelled(), OcrCancelled);
}

TEST(OcrOrtEnv, SharedOrtEnvIsStable) {
  Ort::Env& a = sherpa_onnx::ocr::SharedOrtEnv();
  Ort::Env& b = sherpa_onnx::ocr::SharedOrtEnv();
  EXPECT_EQ(&a, &b);
}

TEST(OcrRecognizeContext, RunPhaseEmitsZeroThenOne) {
  std::vector<std::pair<int, int>> bars;
  OcrRecognizeContext ctx;
  ctx.progress = [&](const OcrProgressTick& tick) {
    bars.emplace_back(tick.done, tick.total);
  };
  bool ran = false;
  ctx.RunPhase(kOcrPhaseDecode, [&] { ran = true; });
  EXPECT_TRUE(ran);
  ASSERT_EQ(bars.size(), 2u);
  EXPECT_EQ(bars[0].first, 0);
  EXPECT_EQ(bars[0].second, 1);
  EXPECT_EQ(bars[1].first, 1);
  EXPECT_EQ(bars[1].second, 1);
}

TEST(OcrRecognizeContext, ThrottlesSamePhaseUnlessComplete) {
  std::vector<std::pair<int, int>> bars;
  OcrRecognizeContext ctx;
  ctx.progress_min_interval_ms = 200;
  ctx.progress = [&](const OcrProgressTick& tick) {
    bars.emplace_back(tick.done, tick.total);
  };
  ctx.Report(kOcrPhaseDecode, 1, 10);
  ctx.Report(kOcrPhaseDecode, 2, 10);
  ctx.Report(kOcrPhaseDecode, 3, 10);
  ctx.Report(kOcrPhaseDecode, 10, 10);
  ASSERT_EQ(bars.size(), 2u);
  EXPECT_EQ(bars[0].first, 1);
  EXPECT_EQ(bars[1].first, 10);
}

TEST(OcrRecognizeContext, PhaseChangeBypassesThrottle) {
  std::vector<std::string> phases;
  OcrRecognizeContext ctx;
  ctx.progress_min_interval_ms = 200;
  ctx.progress = [&](const OcrProgressTick& tick) { phases.push_back(tick.phase); };
  ctx.Report(kOcrPhaseVision, 0, 1);
  ctx.Report(kOcrPhaseDecode, 1, 8);
  ASSERT_EQ(phases.size(), 2u);
  EXPECT_EQ(phases[0], kOcrPhaseVision);
  EXPECT_EQ(phases[1], kOcrPhaseDecode);
}

TEST(OcrRecognizeContext, ZeroIntervalIsUnthrottled) {
  std::vector<int> done;
  OcrRecognizeContext ctx;
  ctx.progress_min_interval_ms = 0;
  ctx.progress = [&](const OcrProgressTick& tick) { done.push_back(tick.done); };
  ctx.Report(kOcrPhaseDecode, 1, 4);
  ctx.Report(kOcrPhaseDecode, 2, 4);
  ctx.Report(kOcrPhaseDecode, 3, 4);
  ASSERT_EQ(done.size(), 3u);
}
