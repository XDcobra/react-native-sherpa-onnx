#include "OcrFactory.h"

#include "ppocr/PpocrBackend.h"

#include <stdexcept>

namespace sherpa_onnx {
namespace ocr {

std::unique_ptr<OcrBackend> CreateOcrBackend(const std::string& model_type) {
  if (model_type == "ppocr" || model_type == "auto") {
    // "auto" resolves to the only registered family in v1.
    return std::make_unique<ppocr::PpocrBackend>();
  }
  throw std::invalid_argument(
      "Unknown OCR modelType/backend '" + model_type +
      "'. Supported in this build: ppocr (auto → ppocr). "
      "Add a new OcrBackend implementation and Factory branch to extend.");
}

}  // namespace ocr
}  // namespace sherpa_onnx
