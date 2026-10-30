/**
 * One row per PaddleOCR-VL recognize task. Adding a task is a table change.
 */
#pragma once

#include "../OcrInstruction.h"
#include "../OcrTypes.h"
#include "PaddleocrVlImageOps.h"

#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

enum class PaddleocrVlParser : uint8_t {
  kText = 0,
  kOtsl,
  kSpotting,
  kPassthrough,
  kGfmTable,
};

struct PaddleocrVlTaskProfile {
  PaddleocrVlTask task;
  const char* id;
  const char* prompt_suffix;
  int default_max_pixels;
  bool upscale_small_2x;
  OcrContentFormat content_format;
  PaddleocrVlParser parser;
};

inline constexpr PaddleocrVlTaskProfile kPaddleocrVlTaskProfiles[] = {
    {PaddleocrVlTask::kOcr, "ocr", "OCR:", kOfficialMaxPixels, false,
     OcrContentFormat::kMarkdown, PaddleocrVlParser::kText},
    {PaddleocrVlTask::kTable, "table", "Table Recognition:", kOfficialMaxPixels,
     false, OcrContentFormat::kMarkdown, PaddleocrVlParser::kOtsl},
    {PaddleocrVlTask::kFormula, "formula", "Formula Recognition:",
     kOfficialMaxPixels, false, OcrContentFormat::kLatex,
     PaddleocrVlParser::kPassthrough},
    {PaddleocrVlTask::kChart, "chart", "Chart Recognition:", kOfficialMaxPixels,
     false, OcrContentFormat::kMarkdown, PaddleocrVlParser::kGfmTable},
    {PaddleocrVlTask::kSeal, "seal", "Seal Recognition:", kOfficialMaxPixels,
     false, OcrContentFormat::kPlain, PaddleocrVlParser::kPassthrough},
    {PaddleocrVlTask::kSpotting, "spotting", "Spotting:", kSpottingMaxPixels, true,
     OcrContentFormat::kPlain, PaddleocrVlParser::kSpotting},
};

inline const PaddleocrVlTaskProfile& ProfileFor(PaddleocrVlTask task) {
  for (const auto& row : kPaddleocrVlTaskProfiles) {
    if (row.task == task) return row;
  }
  return kPaddleocrVlTaskProfiles[0];
}

inline const PaddleocrVlTaskProfile& ProfileForId(const std::string& id) {
  for (const auto& row : kPaddleocrVlTaskProfiles) {
    if (id == row.id) return row;
  }
  return kPaddleocrVlTaskProfiles[0];
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
