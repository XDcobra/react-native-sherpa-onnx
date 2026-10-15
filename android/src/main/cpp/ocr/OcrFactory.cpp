#include "OcrFactory.h"

#include "doctr/DoctrBackend.h"
#include "ppocr/PpocrBackend.h"

#include <stdexcept>

namespace sherpa_onnx {
namespace ocr {

std::unique_ptr<OcrBackend> CreateOcrBackend(const std::string& model_type) {
  if (model_type == "ppocr" || model_type == "auto") {
    // "auto" resolves via detect; ppocr is still the default fallback.
    return std::make_unique<ppocr::PpocrBackend>();
  }
  if (model_type == "doctr") {
    return std::make_unique<doctr::DoctrBackend>();
  }
  throw std::invalid_argument(
      "Unknown OCR modelType/backend '" + model_type +
      "'. Supported in this build: ppocr, doctr (auto → ppocr). "
      "Add a new OcrBackend implementation and Factory branch to extend.");
}

}  // namespace ocr
}  // namespace sherpa_onnx
