#pragma once

#include "ReaderDocument.h"

#include "../textbuffer/TxtOcrLayout.h"
#include "../textbuffer/TxtOfflineEntry.h"

#include <vector>

namespace sherpa_onnx {
namespace reader {

/** A text block recognized on one frame (a page or an image). */
struct OcrTextBlock {
  ReaderBlockType type = ReaderBlockType::Paragraph;
  int headingLevel = 0;
  uint32_t flags = 0;  // ReaderBlockFlags
  int utf16Start = 0;  // range in the OCR text buffer
  int utf16End = 0;
  bool hasRect = false;
  float rect[4] = {0, 0, 0, 0};  // x, y, w, h normalized to the frame
};

struct OcrFrameBlocks {
  int frameIndex = 0;
  std::vector<OcrTextBlock> blocks;
};

/**
 * Blocks of an OCR text buffer, per recognized frame (TxtOcrLayout):
 * - the frame's text split at blank lines (recognize writes paragraphs that way);
 * - typed by the model's layout elements: title → heading 1, section header →
 *   heading (its level, else 2), page header / footer → furniture;
 * - placed by the union of their line boxes, else by the element's box;
 * - a short paragraph that is only a page number, at the top or bottom tenth
 *   of the frame, counts as furniture.
 * Frames without text get no blocks.
 */
std::vector<OcrFrameBlocks> BuildOcrFrameBlocks(const TxtOfflineEntry& ocr,
                                                const TxtOcrLayout& layout);

}  // namespace reader
}  // namespace sherpa_onnx
