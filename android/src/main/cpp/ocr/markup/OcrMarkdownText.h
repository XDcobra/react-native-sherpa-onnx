/**
 * Markdown from VLM OCR families (paddleocr_vl, nemotron_parse) → reading
 * text: paragraphs separated by a blank line, markup removed, headings and
 * list items reported as layout elements (UTF-16 ranges, no geometry).
 */
#pragma once

#include "../OcrTypes.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

struct OcrReadingText {
  std::string text_utf8;
  /** Headings (`#`…`######`) and list items; plain paragraphs have none. */
  std::vector<OcrLayoutElement> elements;
};

/**
 * @param soft_wrap  true: consecutive lines form one paragraph (Markdown
 *                   soft wraps); false: every line is its own block.
 * Table rows (`| a | b |`) stay together as one block, one row per line;
 * separator rows are dropped. HTML tags and emphasis markers are removed.
 */
OcrReadingText MarkdownToReadingText(const std::string& markdown, bool soft_wrap,
                                     int frame_index);

}  // namespace ocr
}  // namespace sherpa_onnx
