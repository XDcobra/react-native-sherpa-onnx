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
  std::vector<OcrSpan> spans;
};

/**
 * `frame_w` / `frame_h` are the source OcrFrameView size. Locs are fractions
 * of that frame (loc / 500), not of the 2048 canvas.
 */
DocTagsParse ParseDocTags(const std::string& doctags, int frame_w, int frame_h,
                          int frame_index);

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
