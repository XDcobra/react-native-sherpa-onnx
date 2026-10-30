/**
 * NVIDIA control-token prompt. One token per group, documented order:
 * `</s><s>` + bbox + classes + text + pic.
 */
#pragma once

#include "../OcrInstruction.h"

#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

inline std::string BuildNemotronPrompt(const NemotronParseOutput& output) {
  std::string prompt = "</s><s>";
  switch (output.layout) {
    case NemotronParseLayout::kNone:
      prompt += "<no_bbox><no_classes>";
      break;
    case NemotronParseLayout::kBoxes:
      prompt += "<predict_bbox><no_classes>";
      break;
    case NemotronParseLayout::kBoxesAndClasses:
      prompt += "<predict_bbox><predict_classes>";
      break;
  }
  switch (output.text) {
    case NemotronParseText::kMarkdown:
      prompt += "<output_markdown>";
      break;
    case NemotronParseText::kPlain:
      prompt += "<output_plain>";
      break;
    case NemotronParseText::kNone:
      prompt += "<output_no_text>";
      break;
  }
  prompt += output.text_in_pictures ? "<predict_text_in_pic>"
                                    : "<predict_no_text_in_pic>";
  return prompt;
}

inline const char* NemotronContentFormatLog(const NemotronParseOutput& output) {
  switch (output.text) {
    case NemotronParseText::kMarkdown:
      return "markdown";
    case NemotronParseText::kPlain:
      return "plain";
    case NemotronParseText::kNone:
      return "null";
  }
  return "null";
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
