/**
 * Hardcoded granite chat expansion. One user turn, one image, generation prompt.
 * Does not interpret chat_template.jinja.
 */
#pragma once

#include "DocVlmTokenizer.h"

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

/**
 * Prompt ids for `rows`×`cols` tiles.
 * rows == 0 && cols == 0 is the unsplit single-image form.
 * Image tokens are looked up, not hardcoded. `image_seq_len` is 64.
 */
std::vector<int32_t> BuildPromptIds(const DocVlmTokenizer& tokenizer, int rows, int cols);

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
