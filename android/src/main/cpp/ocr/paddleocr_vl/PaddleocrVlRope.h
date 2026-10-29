#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

struct RopeIndex {
  /** position_ids layout [3, B, S] packed as t then h then w, B=1. */
  std::vector<int64_t> position_ids;
  int64_t rope_delta = 0;
  int seq = 0;
};

/**
 * Host 3D M-RoPE indices. input_ids is [S] (batch 1).
 * image_grid_thw is [t, h, w] in patch units.
 */
RopeIndex ComputeRopeIndex(const std::vector<int64_t>& input_ids, int grid_t, int grid_h,
                           int grid_w, int image_token_id = 100295,
                           int spatial_merge = 2);

/** Decode-step 3D ids: same t/h/w, offset by past_len + rope_delta. */
std::vector<int64_t> DecodePositionIds(int past_len, int rope_delta, int seq = 1);

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
