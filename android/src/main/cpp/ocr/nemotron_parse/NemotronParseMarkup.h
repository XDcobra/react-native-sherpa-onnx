#pragma once

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
};

/** Split generated markup into raw / markdown / line spans. */
NemotronParseMarkup ParseNemotronMarkup(const std::string& generated, int frame_w,
                                        int frame_h, int frame_index);

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
