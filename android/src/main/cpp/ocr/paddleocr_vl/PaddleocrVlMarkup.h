#pragma once

#include "../OcrTypes.h"

#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

struct PaddleocrVlMarkup {
  std::string raw_utf8;
  std::string markdown_utf8;
  std::string text_utf8;
  std::vector<OcrSpan> spans;
};

/** `ocr` (default) or `spotting`. Other values are treated as `ocr`. */
struct PaddleocrVlParseOptions {
  std::string task = "ocr";
  int frame_width = 0;
  int frame_height = 0;
  int frame_index = 0;
};

/**
 * Strip trailing EOS. `ocr`: keep markdown/HTML, plaintext via layout_text,
 * spans empty. `spotting`: parse eight `<|LOC_n|>` quads from raw before
 * stripping specials.
 */
PaddleocrVlMarkup ParsePaddleocrVlMarkup(
    const std::string& generated,
    const PaddleocrVlParseOptions& options = {});

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
