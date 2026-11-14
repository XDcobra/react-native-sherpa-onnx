#pragma once

#include <string>
#include <vector>

/**
 * OCR layout of an offline text buffer filled by recognize(): where each
 * recognized frame landed in the text, the frame size the quads refer to, and
 * the model's layout elements (headings, list items, pictures, page headers…).
 * Set once after populate; read by the reader to build pages from OCR text.
 */
struct TxtOcrFrame {
  int frameIndex = 0;
  int utf16Start = 0;  // empty range when the frame had no text
  int utf16End = 0;
  int width = 0;  // pixels
  int height = 0;
};

struct TxtOcrElement {
  std::string kind;  // OcrElementKindName: text, title, section_header, list_item, picture, …
  int frameIndex = 0;
  bool hasQuad = false;
  float quad[8] = {0, 0, 0, 0, 0, 0, 0, 0};  // frame pixels, top-left origin
  bool hasUtf16 = false;
  int utf16Start = 0;
  int utf16End = 0;
  int headingLevel = 0;  // 0 = none
};

struct TxtOcrLayout {
  std::string family;  // ppocr | doctr | doc_vlm | nemotron_parse | paddleocr_vl
  std::string modelId;  // optional; identifies results for sidecars
  std::string imageBufferId;
  std::vector<TxtOcrFrame> frames;
  std::vector<TxtOcrElement> elements;
};
