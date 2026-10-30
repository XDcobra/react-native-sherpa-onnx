#include "OcrCrop.h"

#include <algorithm>
#include <stdexcept>

namespace sherpa_onnx {
namespace ocr {

OcrCroppedFrame::OcrCroppedFrame(const OcrFrameView& frame,
                                 const OcrPixelRect& crop) {
  if (!frame.rgb || frame.width <= 0 || frame.height <= 0) {
    throw std::invalid_argument("OcrCrop: empty frame");
  }
  crop_ = ClampRect(crop, frame.width, frame.height);
  if (!OcrPixelRectValid(crop_)) {
    throw std::invalid_argument("OcrCrop: invalid crop");
  }
  rgb_.resize(static_cast<size_t>(crop_.width) * crop_.height * 3);
  for (int y = 0; y < crop_.height; ++y) {
    const uint8_t* src =
        frame.rgb +
        (static_cast<size_t>(crop_.y + y) * frame.width + crop_.x) * 3;
    uint8_t* dst = rgb_.data() + static_cast<size_t>(y) * crop_.width * 3;
    std::copy(src, src + static_cast<size_t>(crop_.width) * 3, dst);
  }
  view_.rgb = rgb_.data();
  view_.width = crop_.width;
  view_.height = crop_.height;
  view_.frame_index = frame.frame_index;
}

void OcrCroppedFrame::TranslateResult(OcrResult& result) const {
  const float dx = static_cast<float>(crop_.x);
  const float dy = static_cast<float>(crop_.y);
  for (auto& span : result.spans) {
    span.quad = TranslateQuad(span.quad, dx, dy);
  }
  for (auto& element : result.elements) {
    if (element.has_quad) {
      element.quad = TranslateQuad(element.quad, dx, dy);
    }
  }
}

}  // namespace ocr
}  // namespace sherpa_onnx
