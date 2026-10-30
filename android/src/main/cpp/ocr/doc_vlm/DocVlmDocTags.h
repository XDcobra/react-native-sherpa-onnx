/**
 * v1 DocTags extractor: plain text, lossy markdown, axis-aligned quads.
 * Not a Docling document model.
 */
#pragma once

#include "../OcrTypes.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

struct DocTagsParse {
  std::string text_utf8;
  std::string markdown_utf8;
  /** Granite `<_Lang_>` token inside `<code>`, else empty. */
  std::string language;
  std::vector<OcrSpan> spans;
  std::vector<OcrLayoutElement> elements;
};

/**
 * `frame_w` / `frame_h` are the source OcrFrameView size. Locs are fractions
 * of that frame (loc / 500), not of the 2048 canvas.
 */
DocTagsParse ParseDocTags(const std::string& doctags, int frame_w, int frame_h,
                          int frame_index);

/**
 * regionText HF emits bare prose (no DocTags). Keep it as text with no
 * elements or spans — do not invent geometry for the requested region.
 */
void AdoptBareProse(DocTagsParse& parsed, const std::string& raw);

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
