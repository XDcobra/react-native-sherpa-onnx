/**
 * Reading order and paragraphs for line-level OCR (ppocr, doctr, paddleocr_vl
 * spotting): detectors return text lines with boxes in a rough top-to-bottom
 * order and join them with "\n". This puts the lines of one frame into
 * reading order (columns via recursive XY cuts, right-to-left and vertical
 * text supported), groups them into paragraphs from their geometry and
 * rebuilds the text: lines of a paragraph joined by a space (no space between
 * CJK characters, hyphenated line ends rejoined), paragraphs by a blank line.
 * Spans keep their quads with ranges into the new text.
 */
#pragma once

#include "OcrTypes.h"

namespace sherpa_onnx {
namespace ocr {

enum class OcrReadingDirection : uint8_t {
  kLtr = 0,  // left-to-right lines / columns (Latin, Cyrillic, …)
  kRtl = 1,  // right-to-left columns; vertical text read right to left (manga)
};

/** Rearranges the line spans of a single-frame result in place. */
void ArrangeLinesIntoParagraphs(OcrResult* frame_result, OcrReadingDirection direction);

}  // namespace ocr
}  // namespace sherpa_onnx
