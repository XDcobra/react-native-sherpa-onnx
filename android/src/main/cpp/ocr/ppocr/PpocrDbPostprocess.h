#pragma once

#include "PpocrImageOps.h"

#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {

struct DetBox {
  float quad[8] = {};  // tl,tr,br,bl in source image coords
  float score = 0.f;
};

/**
 * OpenCV-free DB postprocess: threshold → dilate → connected components →
 * axis-aligned expanded boxes (simple unclip). Good enough for spike / golden.
 * pred: HxW float map from det network (already at dst size).
 */
std::vector<DetBox> DbPostprocess(
    const float* pred,
    int pred_h,
    int pred_w,
    const ScaleParam& scale,
    float box_thresh,
    float box_score_thresh,
    float unclip_ratio);

/** Sort boxes top-to-bottom, then left-to-right. */
void SortDetBoxesReadingOrder(std::vector<DetBox>& boxes);

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
