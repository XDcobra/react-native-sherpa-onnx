/**
 * One row per Granite Docling recognize task. Adding a task is a table change.
 */
#pragma once

#include "../OcrInstruction.h"
#include "../OcrTypes.h"

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

struct DocVlmTaskProfile {
  DocVlmTask task;
  DocVlmElement element;
  const char* id;
  const char* user_text_prefix;
  bool needs_region;
  bool has_content;
  OcrContentFormat content_format;
};

inline constexpr DocVlmTaskProfile kDocVlmTaskProfiles[] = {
    {DocVlmTask::kPage, DocVlmElement::kTable, "page",
     "Convert this page to docling.", false, true, OcrContentFormat::kMarkdown},
    {DocVlmTask::kElement, DocVlmElement::kTable, "element_table",
     "Convert table to OTSL.", false, true, OcrContentFormat::kMarkdown},
    {DocVlmTask::kElement, DocVlmElement::kChart, "element_chart",
     "Convert chart to table.", false, true, OcrContentFormat::kMarkdown},
    {DocVlmTask::kElement, DocVlmElement::kFormula, "element_formula",
     "Convert formula to LaTeX.", false, true, OcrContentFormat::kLatex},
    {DocVlmTask::kElement, DocVlmElement::kCode, "element_code",
     "Convert code to text.", false, true, OcrContentFormat::kCode},
    {DocVlmTask::kRegionText, DocVlmElement::kTable, "regionText",
     "OCR the text in a specific location: ", true, true,
     OcrContentFormat::kPlain},
    {DocVlmTask::kIdentifyElement, DocVlmElement::kTable, "identifyElement",
     "Identify element at: ", true, true, OcrContentFormat::kPlain},
};

inline const DocVlmTaskProfile& ProfileFor(const DocVlmInstruction& inst) {
  for (const auto& row : kDocVlmTaskProfiles) {
    if (row.task != inst.task) continue;
    if (row.task == DocVlmTask::kElement && row.element != inst.element) {
      continue;
    }
    return row;
  }
  return kDocVlmTaskProfiles[0];
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
