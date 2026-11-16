#include "DocTextPopulate.h"

#include "../textbuffer/TextRegistry.h"

#include <vector>

namespace sherpa_onnx {
namespace document {

bool PopulateTextBufferFromDocument(const std::string& bufferId,
                                    const ExtractTextResult& result,
                                    std::string* error) {
  std::vector<TxtSpatialSpan> spans;
  spans.reserve(result.spans.size());
  for (const auto& s : result.spans) {
    TxtSpatialSpan t;
    t.utf16Start = s.utf16_start;
    t.utf16End = s.utf16_end;
    t.level = s.level.empty() ? "block" : s.level;
    t.sourceImageBufferId = "";
    t.frameIndex = 0;
    t.origin = "markup";
    t.hasSectionIndex = true;
    t.sectionIndex = s.section_index;
    t.href = s.href;
    spans.push_back(std::move(t));
  }
  if (!txt_populate_offline_if_empty(bufferId, result.text, {}, {}, {}, "", "", "",
                                     spans, error)) {
    return false;
  }
  if (result.structure) {
    return txt_set_offline_structure(bufferId, result.structure, error);
  }
  return true;
}

}  // namespace document
}  // namespace sherpa_onnx
