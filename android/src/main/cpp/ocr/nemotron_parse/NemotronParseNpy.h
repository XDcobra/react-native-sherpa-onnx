#pragma once

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

/** Load RADIO pos_embed.npy as float32 [16384, 1152] (leading 1 squeezed). */
std::vector<float> LoadPosEmbedNpy(const std::string& path);

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
