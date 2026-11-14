#include "PdfTextPopulate.h"

#include "../textbuffer/TextRegistry.h"
#include "../textbuffer/TxtStructure.h"

#include <vector>

namespace sherpa_onnx {
namespace pdf {

bool PopulateTextFromPdf(const std::string& text_buffer_id, const PdfTextLayerResult& result,
                         std::string* error) {
  const bool structured = result.structure != nullptr;
  std::vector<TxtSpatialSpan> spans;
  spans.reserve(result.spans.size());
  for (const PdfTextSpan& s : result.spans) {
    TxtSpatialSpan t;
    t.utf16Start = s.utf16_start;
    t.utf16End = s.utf16_end;
    t.level = s.level;
    t.frameIndex = s.frame_index;
    for (int i = 0; i < 8; ++i) t.quad[i] = s.quad[i];
    t.origin = "textLayer";
    t.hasPageNumber = true;
    t.pageNumber = s.page_number;
    t.hasPageWidth = true;
    t.pageWidth = s.page_width;
    t.hasPageHeight = true;
    t.pageHeight = s.page_height;
    if (structured) {
      t.hasSectionIndex = true;
      t.sectionIndex = s.page_number - 1;
      t.href = "page:" + std::to_string(s.page_number);
    }
    spans.push_back(std::move(t));
  }
  if (!txt_populate_offline_if_empty(text_buffer_id, result.text, {}, {}, {}, "", "", "", spans,
                                     error)) {
    return false;
  }
  if (structured) {
    return txt_set_offline_structure(text_buffer_id, result.structure, error);
  }
  return true;
}

}  // namespace pdf
}  // namespace sherpa_onnx
