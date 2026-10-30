/**
 * Engine-owned crop of an OcrFrameView. Backends never see full-frame coords
 * when a crop is set; the engine translates spans back.
 */
#pragma once

#include "OcrGeometry.h"

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

class OcrCroppedFrame {
 public:
  OcrCroppedFrame() = default;
  OcrCroppedFrame(const OcrFrameView& frame, const OcrPixelRect& crop);

  const OcrFrameView& view() const { return view_; }
  const OcrPixelRect& crop() const { return crop_; }
  int dx() const { return crop_.x; }
  int dy() const { return crop_.y; }

  void TranslateResult(OcrResult& result) const;

 private:
  std::vector<uint8_t> rgb_;
  OcrFrameView view_{};
  OcrPixelRect crop_{};
};

}  // namespace ocr
}  // namespace sherpa_onnx
