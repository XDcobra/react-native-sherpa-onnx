/**
 * Hardcoded granite chat expansion. One user turn, one image, generation prompt.
 * Does not interpret chat_template.jinja.
 */
#pragma once

#include "../OcrInstruction.h"
#include "DocVlmTokenizer.h"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

/** Pixel rect → `<loc_x1><loc_y1><loc_x2><loc_y2>` on the 0–500 granite grid. */
std::string FormatGraniteLocs(const OcrPixelRect& region, int frame_w, int frame_h);

/** Profile user text, with locs filled for region tasks. */
std::string BuildDocVlmUserText(const DocVlmInstruction& inst, int frame_w,
                                int frame_h);

/**
 * Prompt ids for `rows`×`cols` tiles.
 * rows == 0 && cols == 0 is the unsplit single-image form.
 * Image tokens are looked up, not hardcoded. `image_seq_len` is 64.
 * Empty `user_text` → page default (`Convert this page to docling.`).
 */
std::vector<int32_t> BuildPromptIds(const DocVlmTokenizer& tokenizer, int rows,
                                    int cols, std::string_view user_text = {});

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
