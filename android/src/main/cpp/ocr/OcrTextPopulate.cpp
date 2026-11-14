#include "OcrTextPopulate.h"

#include "../image/ImageRegistry.h"
#include "../textbuffer/TextRegistry.h"
#include "markup/OcrElementKind.h"

#include <memory>
#include <unordered_map>

namespace sherpa_onnx {
namespace ocr {

namespace {

const char* SpanLevelName(OcrSpanLevel level) {
  switch (level) {
    case OcrSpanLevel::kWord: return "word";
    case OcrSpanLevel::kBlock: return "block";
    default: return "line";
  }
}

}  // namespace

bool PopulateTextFromOcr(const std::string& text_buffer_id, const std::string& image_buffer_id,
                         const std::string& family, const OcrResult& result,
                         std::string* error_code, std::string* error_message) {
  auto& images = image::ImageRegistry::Instance();
  std::unordered_map<int, image::ImageFrameInfo> frame_info;
  auto info_of = [&](int frame) -> const image::ImageFrameInfo* {
    auto it = frame_info.find(frame);
    if (it == frame_info.end()) {
      image::ImageFrameInfo fi;
      if (!images.GetFrameInfo(image_buffer_id, frame, fi)) fi.index = -1;
      it = frame_info.emplace(frame, fi).first;
    }
    return it->second.index < 0 ? nullptr : &it->second;
  };

  std::vector<TxtSpatialSpan> spans;
  spans.reserve(result.spans.size());
  for (const OcrSpan& span : result.spans) {
    TxtSpatialSpan t;
    t.utf16Start = span.utf16_start;
    t.utf16End = span.utf16_end;
    t.level = SpanLevelName(span.level);
    t.sourceImageBufferId = image_buffer_id;
    t.frameIndex = span.frame_index;
    for (int i = 0; i < 8; ++i) t.quad[i] = span.quad.xy[i];
    t.hasConfidence = true;
    t.confidence = span.confidence;
    t.origin = "ocr";
    if (const image::ImageFrameInfo* fi = info_of(span.frame_index)) {
      if (!fi->sourceVideoBufferId.empty() && fi->sourcePtsUs >= 0) {
        t.hasPtsMs = true;
        t.ptsMs = static_cast<double>(fi->sourcePtsUs) / 1000.0;
      }
      // Where the frame came from: PDF page, document section / archive path.
      if (fi->pageNumber > 0) {
        t.hasPageNumber = true;
        t.pageNumber = fi->pageNumber;
      }
      if (fi->sectionIndex >= 0) {
        t.hasSectionIndex = true;
        t.sectionIndex = fi->sectionIndex;
      }
      if (!fi->href.empty()) t.href = fi->href;
    }
    spans.push_back(std::move(t));
  }

  std::string populate_error;
  if (!txt_populate_offline_if_empty(text_buffer_id, result.text_utf8, {}, {}, {}, "", "", "",
                                     spans, &populate_error)) {
    if (error_code) *error_code = "OCR_ALREADY_POPULATED";
    if (error_message) {
      *error_message = populate_error.empty() ? "Text buffer already populated" : populate_error;
    }
    return false;
  }

  auto layout = std::make_shared<TxtOcrLayout>();
  layout->family = family;
  layout->imageBufferId = image_buffer_id;
  layout->frames.reserve(result.frames.size());
  for (const OcrFrameText& f : result.frames) {
    layout->frames.push_back({f.frame_index, f.utf16_start, f.utf16_end, f.width, f.height});
  }
  layout->elements.reserve(result.elements.size());
  for (const OcrLayoutElement& e : result.elements) {
    TxtOcrElement out;
    out.kind = OcrElementKindName(e.kind);
    out.frameIndex = e.frame_index;
    out.hasQuad = e.has_quad;
    for (int i = 0; i < 8; ++i) out.quad[i] = e.quad.xy[i];
    out.hasUtf16 = e.has_utf16;
    out.utf16Start = e.utf16_start;
    out.utf16End = e.utf16_end;
    out.headingLevel = e.heading_level.value_or(0);
    layout->elements.push_back(std::move(out));
  }
  txt_set_offline_ocr_layout(text_buffer_id, std::move(layout));
  return true;
}

}  // namespace ocr
}  // namespace sherpa_onnx
