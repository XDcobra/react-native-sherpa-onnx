#pragma once

#include "../OcrInstruction.h"
#include "../OcrTypes.h"

#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

struct NemotronParseMarkup {
  std::string raw_utf8;
  std::string markdown_utf8;
  std::string text_utf8;
  std::vector<OcrSpan> spans;
  std::vector<OcrLayoutElement> elements;
};

/** Split generated markup into raw, GFM markdown, plaintext, and line spans. */
NemotronParseMarkup ParseNemotronMarkup(const std::string& generated, int frame_w,
                                        int frame_h, int frame_index);

/**
 * Map parsed markup onto the result using the executed output profile.
 * Layout `none` drops spans/elements. `text: none` drops content and utf16.
 */
void ApplyNemotronOutput(OcrResult& result, const NemotronParseMarkup& parsed,
                         const NemotronParseOutput& output);

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
