#pragma once

#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

/**
 * Content-normalized NaViT interpolate. `pos_embed` is [16384, 1152] f32.
 * `patches` is [rows*cols, 1152] after patch_embed. Returns [rows*cols, 1152].
 */
std::vector<float> AddNavitPositions(const std::vector<float>& patches,
                                     const std::vector<float>& pos_embed,
                                     int image_h, int image_w, int content_h,
                                     int content_w);

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
