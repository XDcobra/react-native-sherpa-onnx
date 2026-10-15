/**
 * DB postprocess for doctr/OnnxTR det output.
 * Sigmoid on logits + threshold + dilate + CC + unclip.
 * Maps boxes from fixed det input size (e.g. 1024×1024) back to source image coords.
 */
#pragma once

#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doctr {

struct DetBox {
  float quad[8] = {};  // tl,tr,br,bl in source image coords
  float score = 0.f;
};

/**
 * DB postprocess for doctr.
 * @param logits  Raw det output (NOT sigmoid'd); shape [H, W].
 * @param pred_h  Height of det output map.
 * @param pred_w  Width of det output map.
 * @param src_w   Original source image width.
 * @param src_h   Original source image height.
 * @param box_thresh       Binary threshold on sigmoid output.
 * @param box_score_thresh  Min mean-score for a CC to produce a box.
 * @param unclip_ratio     Expansion ratio for boxes.
 */
std::vector<DetBox> DoctrDbPostprocess(
    const float* logits,
    int pred_h,
    int pred_w,
    int src_w,
    int src_h,
    float box_thresh,
    float box_score_thresh,
    float unclip_ratio);

/** Sort boxes top-to-bottom, then left-to-right. */
void SortDetBoxesReadingOrder(std::vector<DetBox>& boxes);

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
