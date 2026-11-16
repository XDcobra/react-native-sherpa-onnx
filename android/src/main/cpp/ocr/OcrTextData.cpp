#include "OcrTextData.h"

#include "markup/OcrElementKind.h"

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

OcrTextData MakeOcrTextData(
    const std::string& image_buffer_id, const std::string& family, const OcrResult& result,
    const std::function<const image::ImageFrameInfo*(int frame)>& frame_info) {
  OcrTextData data;
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
    if (const image::ImageFrameInfo* fi = frame_info ? frame_info(span.frame_index) : nullptr) {
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
  data.spans = std::move(spans);
  data.layout = std::move(layout);
  return data;
}

}  // namespace ocr
}  // namespace sherpa_onnx
