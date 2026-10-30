#include <gtest/gtest.h>

#include "OcrCapabilities.h"
#include "OcrRecognizeSpec.h"
#include "OcrTypes.h"

#include <string>
#include <variant>
#include <vector>

using sherpa_onnx::ocr::DefaultInstructionForFamily;
using sherpa_onnx::ocr::DocVlmElement;
using sherpa_onnx::ocr::DocVlmInstruction;
using sherpa_onnx::ocr::DocVlmTask;
using sherpa_onnx::ocr::NemotronParseInstruction;
using sherpa_onnx::ocr::NemotronParseLayout;
using sherpa_onnx::ocr::NemotronParseText;
using sherpa_onnx::ocr::OcrGranularity;
using sherpa_onnx::ocr::OcrPixelRect;
using sherpa_onnx::ocr::OcrRecognizeRequest;
using sherpa_onnx::ocr::PaddleocrVlInstruction;
using sherpa_onnx::ocr::PaddleocrVlTask;
using sherpa_onnx::ocr::ParseOcrRecognizeSpec;
using sherpa_onnx::ocr::SerializeOcrRecognizeSpec;
using sherpa_onnx::ocr::ValidateRequest;
using sherpa_onnx::ocr::kOcrErrInstructionFamilyMismatch;
using sherpa_onnx::ocr::kOcrErrInstructionUnsupported;
using sherpa_onnx::ocr::kOcrErrInvalidRecognizeSpec;
using sherpa_onnx::ocr::kOcrErrInvalidRegion;
using sherpa_onnx::ocr::kOcrErrUnsupportedGranularity;

TEST(OcrRecognizeSpec, RoundTripPaddleSpottingCrop) {
  const auto parsed = ParseOcrRecognizeSpec(
      "v1;family=paddleocr_vl;task=spotting;cx=0;cy=0;cw=800;ch=600");
  ASSERT_TRUE(parsed.ok) << parsed.error_message;
  EXPECT_EQ(parsed.family, "paddleocr_vl");
  const auto* inst =
      std::get_if<PaddleocrVlInstruction>(&parsed.request.instruction);
  ASSERT_NE(inst, nullptr);
  EXPECT_EQ(inst->task, PaddleocrVlTask::kSpotting);
  ASSERT_TRUE(parsed.request.crop.has_value());
  EXPECT_EQ(parsed.request.crop->width, 800);
  const std::string again =
      SerializeOcrRecognizeSpec(parsed.family, parsed.request);
  EXPECT_EQ(again,
            "v1;family=paddleocr_vl;task=spotting;cx=0;cy=0;cw=800;ch=600");
  const auto parsed2 = ParseOcrRecognizeSpec(again);
  ASSERT_TRUE(parsed2.ok);
  EXPECT_EQ(SerializeOcrRecognizeSpec(parsed2.family, parsed2.request), again);
}

TEST(OcrRecognizeSpec, RoundTripGraniteRegion) {
  const auto parsed = ParseOcrRecognizeSpec(
      "v1;family=doc_vlm;task=regionText;rx=120;ry=340;rw=600;rh=80");
  ASSERT_TRUE(parsed.ok) << parsed.error_message;
  const auto* inst = std::get_if<DocVlmInstruction>(&parsed.request.instruction);
  ASSERT_NE(inst, nullptr);
  EXPECT_EQ(inst->task, DocVlmTask::kRegionText);
  EXPECT_EQ(inst->region.x, 120);
  const std::string again =
      SerializeOcrRecognizeSpec("doc_vlm", parsed.request);
  EXPECT_EQ(again,
            "v1;family=doc_vlm;task=regionText;rx=120;ry=340;rw=600;rh=80");
}

TEST(OcrRecognizeSpec, GraniteRawFullRoundTrip) {
  const auto parsed = ParseOcrRecognizeSpec("v1;family=doc_vlm;task=page;raw=full");
  ASSERT_TRUE(parsed.ok) << parsed.error_message;
  EXPECT_EQ(parsed.request.raw_mode, sherpa_onnx::ocr::OcrVlmRawMode::kFull);
  EXPECT_EQ(SerializeOcrRecognizeSpec("doc_vlm", parsed.request),
            "v1;family=doc_vlm;task=page;raw=full");
  const auto accepted =
      ParseOcrRecognizeSpec("v1;family=doc_vlm;task=page;raw=accepted");
  ASSERT_TRUE(accepted.ok);
  EXPECT_EQ(accepted.request.raw_mode, sherpa_onnx::ocr::OcrVlmRawMode::kAccepted);
  EXPECT_EQ(SerializeOcrRecognizeSpec("doc_vlm", accepted.request),
            "v1;family=doc_vlm;task=page");
  EXPECT_FALSE(ParseOcrRecognizeSpec("v1;family=ppocr;raw=full").ok);
}

TEST(OcrRecognizeSpec, RoundTripNemotronDefault) {
  OcrRecognizeRequest req;
  req.instruction = DefaultInstructionForFamily("nemotron_parse");
  const std::string spec = SerializeOcrRecognizeSpec("nemotron_parse", req);
  EXPECT_EQ(spec,
            "v1;family=nemotron_parse;task=page;text=markdown;layout=none;pic=1");
  const auto parsed = ParseOcrRecognizeSpec(spec);
  ASSERT_TRUE(parsed.ok) << parsed.error_message;
  const auto* inst =
      std::get_if<NemotronParseInstruction>(&parsed.request.instruction);
  ASSERT_NE(inst, nullptr);
  EXPECT_EQ(inst->output.text, NemotronParseText::kMarkdown);
  EXPECT_EQ(inst->output.layout, NemotronParseLayout::kNone);
  EXPECT_TRUE(inst->output.text_in_pictures);
}

TEST(OcrRecognizeSpec, RejectsUnknownDuplicateMissingNan) {
  EXPECT_FALSE(ParseOcrRecognizeSpec("v2;family=ppocr").ok);
  EXPECT_EQ(ParseOcrRecognizeSpec("v2;family=ppocr").error_code,
            kOcrErrInvalidRecognizeSpec);
  EXPECT_FALSE(ParseOcrRecognizeSpec(
                   "v1;family=paddleocr_vl;task=ocr;task=spotting")
                   .ok);
  EXPECT_FALSE(ParseOcrRecognizeSpec("v1;family=paddleocr_vl;foo=1").ok);
  EXPECT_FALSE(ParseOcrRecognizeSpec("v1;task=ocr").ok);
  EXPECT_FALSE(ParseOcrRecognizeSpec("v1;family=paddleocr_vl;cx=1.5;cy=0;cw=1;ch=1")
                   .ok);
  EXPECT_FALSE(ParseOcrRecognizeSpec("v1;family=doc_vlm;task=element").ok);
}

TEST(OcrRecognizeSpec, RejectsPpocrInstructionKeys) {
  const auto parsed = ParseOcrRecognizeSpec("v1;family=ppocr;task=ocr");
  EXPECT_FALSE(parsed.ok);
  EXPECT_EQ(parsed.error_code, kOcrErrInstructionUnsupported);
}

TEST(OcrCapabilities, Phase1TasksAndGranularity) {
  const auto paddle = sherpa_onnx::ocr::CapabilitiesForFamily("paddleocr_vl");
  EXPECT_EQ(paddle.tasks, (std::vector<std::string>{
                            "ocr", "table", "formula", "chart", "seal", "spotting"}));
  EXPECT_FALSE(paddle.produces_elements);

  const auto granite = sherpa_onnx::ocr::CapabilitiesForFamily("doc_vlm");
  EXPECT_EQ(granite.tasks, (std::vector<std::string>{
                               "page", "element", "regionText", "identifyElement"}));
  EXPECT_TRUE(granite.produces_elements);

  OcrRecognizeRequest page;
  page.instruction = DefaultInstructionForFamily("doc_vlm");
  const auto word = ValidateRequest("doc_vlm", page, OcrGranularity::kWord, 900,
                                    1200);
  EXPECT_FALSE(word.ok);
  EXPECT_EQ(word.error_code, kOcrErrUnsupportedGranularity);

  const auto line = ValidateRequest("doc_vlm", page, OcrGranularity::kLine, 900,
                                    1200);
  EXPECT_TRUE(line.ok);

  DocVlmInstruction region;
  region.task = DocVlmTask::kRegionText;
  region.region = OcrPixelRect{10, 10, 20, 20};
  OcrRecognizeRequest region_req;
  region_req.instruction = region;
  const auto region_ok = ValidateRequest("doc_vlm", region_req,
                                         OcrGranularity::kLine, 900, 1200);
  EXPECT_TRUE(region_ok.ok) << region_ok.error_message;

  region_req.crop = OcrPixelRect{0, 0, 10, 10};
  const auto crop_region = ValidateRequest("doc_vlm", region_req,
                                           OcrGranularity::kLine, 900, 1200);
  EXPECT_FALSE(crop_region.ok);
  EXPECT_EQ(crop_region.error_code, kOcrErrInstructionUnsupported);

  region_req.crop.reset();
  region.region = OcrPixelRect{800, 0, 200, 10};
  region_req.instruction = region;
  const auto outside = ValidateRequest("doc_vlm", region_req,
                                       OcrGranularity::kLine, 900, 1200);
  EXPECT_FALSE(outside.ok);
  EXPECT_EQ(outside.error_code, kOcrErrInvalidRegion);

  DocVlmInstruction element;
  element.task = DocVlmTask::kElement;
  element.element = DocVlmElement::kTable;
  OcrRecognizeRequest element_req;
  element_req.instruction = element;
  const auto element_ok =
      ValidateRequest("doc_vlm", element_req, OcrGranularity::kLine, 720, 360);
  EXPECT_TRUE(element_ok.ok) << element_ok.error_message;
}

TEST(OcrCapabilities, DetectorWordRejected) {
  OcrRecognizeRequest req;
  const auto doctr_word =
      ValidateRequest("doctr", req, OcrGranularity::kWord, 100, 100);
  EXPECT_FALSE(doctr_word.ok);
  EXPECT_EQ(doctr_word.error_code, kOcrErrUnsupportedGranularity);
  const auto ppocr_word =
      ValidateRequest("ppocr", req, OcrGranularity::kWord, 100, 100);
  EXPECT_FALSE(ppocr_word.ok);
  EXPECT_EQ(ppocr_word.error_code, kOcrErrUnsupportedGranularity);
  const auto doctr_line =
      ValidateRequest("doctr", req, OcrGranularity::kLine, 100, 100);
  EXPECT_TRUE(doctr_line.ok);
}

TEST(OcrCapabilities, CropOutsideFrameAndFamilyMismatch) {
  OcrRecognizeRequest req;
  req.instruction = DefaultInstructionForFamily("paddleocr_vl");
  req.crop = OcrPixelRect{800, 0, 200, 10};
  const auto bad = ValidateRequest("paddleocr_vl", req, OcrGranularity::kLine,
                                   900, 1200);
  EXPECT_FALSE(bad.ok);
  EXPECT_EQ(bad.error_code, kOcrErrInvalidRegion);

  req.crop.reset();
  req.instruction = DefaultInstructionForFamily("doc_vlm");
  const auto mismatch =
      ValidateRequest("paddleocr_vl", req, OcrGranularity::kLine, 900, 1200);
  EXPECT_FALSE(mismatch.ok);
  EXPECT_EQ(mismatch.error_code, kOcrErrInstructionFamilyMismatch);
}

TEST(OcrRecognizeSpec, GraniteChartGatedRejected) {
  const auto chart = ParseOcrRecognizeSpec(
      "v1;family=doc_vlm;task=element;element=chart");
  EXPECT_FALSE(chart.ok);
  EXPECT_EQ(chart.error_code, kOcrErrInstructionUnsupported);
}

TEST(OcrRecognizeSpec, NemotronGatedProfilesRejected) {
  const auto boxes = ParseOcrRecognizeSpec(
      "v1;family=nemotron_parse;task=page;text=markdown;layout=boxesAndClasses;pic=0");
  EXPECT_FALSE(boxes.ok);
  EXPECT_EQ(boxes.error_code, kOcrErrInstructionUnsupported);
  const auto plain = ParseOcrRecognizeSpec(
      "v1;family=nemotron_parse;task=page;text=plain;layout=none;pic=1");
  EXPECT_FALSE(plain.ok);
  EXPECT_EQ(plain.error_code, kOcrErrInstructionUnsupported);
}

TEST(OcrCapabilities, GraniteChartRejected) {
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

TEST(OcrCapabilities, NemotronBoxesRejected) {
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

TEST(OcrLoadOptions, DetThreshOmitUsesFamilyDefaultNotRemap) {
  using sherpa_onnx::ocr::ResolveOcrDetThresh;
  using sherpa_onnx::ocr::kDoctrDetBoxScoreThresh;
  using sherpa_onnx::ocr::kDoctrDetBoxThresh;
  using sherpa_onnx::ocr::kOcrDetThreshUnspecified;
  using sherpa_onnx::ocr::kPpocrDetBoxScoreThresh;
  using sherpa_onnx::ocr::kPpocrDetBoxThresh;
  EXPECT_FLOAT_EQ(ResolveOcrDetThresh(kOcrDetThreshUnspecified, kDoctrDetBoxThresh),
                  kDoctrDetBoxThresh);
  EXPECT_FLOAT_EQ(
      ResolveOcrDetThresh(kOcrDetThreshUnspecified, kDoctrDetBoxScoreThresh),
      kDoctrDetBoxScoreThresh);
  EXPECT_FLOAT_EQ(ResolveOcrDetThresh(0.3f, kDoctrDetBoxThresh), 0.3f);
  EXPECT_FLOAT_EQ(ResolveOcrDetThresh(kOcrDetThreshUnspecified, kPpocrDetBoxThresh),
                  kPpocrDetBoxThresh);
  EXPECT_FLOAT_EQ(
      ResolveOcrDetThresh(kOcrDetThreshUnspecified, kPpocrDetBoxScoreThresh),
      kPpocrDetBoxScoreThresh);
  EXPECT_FLOAT_EQ(ResolveOcrDetThresh(0.25f, kPpocrDetBoxThresh), 0.25f);
}

TEST(OcrRecognizeSpec, ElementRoundTrip) {
  DocVlmInstruction inst;
  inst.task = DocVlmTask::kElement;
  inst.element = DocVlmElement::kFormula;
  OcrRecognizeRequest req;
  req.instruction = inst;
  const std::string spec = SerializeOcrRecognizeSpec("doc_vlm", req);
  EXPECT_EQ(spec, "v1;family=doc_vlm;task=element;element=formula");
  const auto parsed = ParseOcrRecognizeSpec(spec);
  ASSERT_TRUE(parsed.ok);
}
