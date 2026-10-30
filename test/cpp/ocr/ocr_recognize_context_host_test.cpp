#include <gtest/gtest.h>

#include "OcrCapabilities.h"
#include "OcrCrop.h"
#include "OcrInstruction.h"
#include "OcrOrtEnv.h"
#include "OcrRecognizeContext.h"
#include "OcrTypes.h"

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

TEST(OcrRecognizeContext, CropTranslatesSpansAndElements) {
  constexpr int kW = 8;
  constexpr int kH = 6;
  std::vector<uint8_t> rgb(static_cast<size_t>(kW) * kH * 3, 7);
  sherpa_onnx::ocr::OcrFrameView frame;
  frame.rgb = rgb.data();
  frame.width = kW;
  frame.height = kH;
  sherpa_onnx::ocr::OcrCroppedFrame cropped(
      frame, sherpa_onnx::ocr::OcrPixelRect{2, 1, 4, 3});
  sherpa_onnx::ocr::OcrResult result;
  sherpa_onnx::ocr::OcrSpan span;
  span.quad.xy[0] = 1.f;
  span.quad.xy[1] = 1.f;
  span.quad.xy[2] = 2.f;
  span.quad.xy[3] = 1.f;
  span.quad.xy[4] = 2.f;
  span.quad.xy[5] = 2.f;
  span.quad.xy[6] = 1.f;
  span.quad.xy[7] = 2.f;
  result.spans.push_back(span);
  sherpa_onnx::ocr::OcrLayoutElement el;
  el.kind = sherpa_onnx::ocr::OcrElementKind::kText;
  el.has_quad = true;
  el.quad = span.quad;
  result.elements.push_back(el);
  cropped.TranslateResult(result);
  EXPECT_FLOAT_EQ(result.spans[0].quad.xy[0], 3.f);
  EXPECT_FLOAT_EQ(result.spans[0].quad.xy[1], 2.f);
  ASSERT_TRUE(result.elements[0].has_quad);
  EXPECT_FLOAT_EQ(result.elements[0].quad.xy[0], 3.f);
  EXPECT_FLOAT_EQ(result.elements[0].quad.xy[1], 2.f);
}

TEST(OcrRecognizeContext, ValidateRequestRejectsUnsupportedGranularity) {
  using sherpa_onnx::ocr::DefaultInstructionForFamily;
  using sherpa_onnx::ocr::OcrGranularity;
  using sherpa_onnx::ocr::OcrRecognizeRequest;
  using sherpa_onnx::ocr::ValidateRequest;
  using sherpa_onnx::ocr::kOcrErrUnsupportedGranularity;
  OcrRecognizeRequest req;
  req.instruction = DefaultInstructionForFamily("doctr");
  const auto rejected =
      ValidateRequest("doctr", req, OcrGranularity::kWord, 100, 80);
  EXPECT_FALSE(rejected.ok);
  EXPECT_EQ(rejected.error_code, kOcrErrUnsupportedGranularity);
}

TEST(OcrRecognizeContext, ValidateRequestFamilyMismatchAndInvalidCrop) {
  using sherpa_onnx::ocr::DefaultInstructionForFamily;
  using sherpa_onnx::ocr::OcrGranularity;
  using sherpa_onnx::ocr::OcrPixelRect;
  using sherpa_onnx::ocr::OcrRecognizeRequest;
  using sherpa_onnx::ocr::ValidateRequest;
  using sherpa_onnx::ocr::kOcrErrInstructionFamilyMismatch;
  using sherpa_onnx::ocr::kOcrErrInvalidRegion;
  OcrRecognizeRequest req;
  req.instruction = DefaultInstructionForFamily("doc_vlm");
  const auto mismatch =
      ValidateRequest("paddleocr_vl", req, OcrGranularity::kLine, 900, 1200);
  EXPECT_FALSE(mismatch.ok);
  EXPECT_EQ(mismatch.error_code, kOcrErrInstructionFamilyMismatch);

  req.instruction = DefaultInstructionForFamily("ppocr");
  req.crop = OcrPixelRect{0, 0, 200, 50};
  const auto outside = ValidateRequest("ppocr", req, OcrGranularity::kLine, 100, 80);
  EXPECT_FALSE(outside.ok);
  EXPECT_EQ(outside.error_code, kOcrErrInvalidRegion);
}

TEST(OcrRecognizeContext, ValidateRequestGraniteChartRejected) {
  using sherpa_onnx::ocr::DocVlmElement;
  using sherpa_onnx::ocr::DocVlmInstruction;
  using sherpa_onnx::ocr::DocVlmTask;
  using sherpa_onnx::ocr::OcrGranularity;
  using sherpa_onnx::ocr::OcrRecognizeRequest;
  using sherpa_onnx::ocr::ValidateRequest;
  using sherpa_onnx::ocr::kOcrErrInstructionUnsupported;
  DocVlmInstruction inst;
  inst.task = DocVlmTask::kElement;
  inst.element = DocVlmElement::kChart;
  OcrRecognizeRequest req;
  req.instruction = inst;
  const auto rejected =
      ValidateRequest("doc_vlm", req, OcrGranularity::kLine, 900, 1200);
  EXPECT_FALSE(rejected.ok);
  EXPECT_EQ(rejected.error_code, kOcrErrInstructionUnsupported);
}

TEST(OcrRecognizeContext, ValidateRequestNemotronBoxesRejected) {
  using sherpa_onnx::ocr::NemotronParseInstruction;
  using sherpa_onnx::ocr::NemotronParseLayout;
  using sherpa_onnx::ocr::OcrGranularity;
  using sherpa_onnx::ocr::OcrRecognizeRequest;
  using sherpa_onnx::ocr::ValidateRequest;
  using sherpa_onnx::ocr::kOcrErrInstructionUnsupported;
  NemotronParseInstruction inst;
  inst.output.layout = NemotronParseLayout::kBoxesAndClasses;
  inst.output.text_in_pictures = false;
  OcrRecognizeRequest req;
  req.instruction = inst;
  const auto rejected =
      ValidateRequest("nemotron_parse", req, OcrGranularity::kLine, 900, 1200);
  EXPECT_FALSE(rejected.ok);
  EXPECT_EQ(rejected.error_code, kOcrErrInstructionUnsupported);
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
