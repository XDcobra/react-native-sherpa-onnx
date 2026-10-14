/**
 * Multi-family OCR backend interface. New families implement this contract only.
 */
#pragma once

#include "OcrTypes.h"

#include <memory>
#include <string>

namespace sherpa_onnx {
namespace ocr {

class OcrBackend {
 public:
  virtual ~OcrBackend() = default;

  virtual void Load(const std::string& model_dir, const OcrLoadOptions& options) = 0;
  virtual OcrResult Recognize(const OcrFrameView& frame) = 0;
  virtual void Release() = 0;

  /** Stable family id, e.g. "ppocr". */
  virtual const char* Family() const = 0;
};

}  // namespace ocr
}  // namespace sherpa_onnx
