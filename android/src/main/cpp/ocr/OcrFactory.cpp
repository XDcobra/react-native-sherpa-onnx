#include "OcrFactory.h"

#include "doc_vlm/DocVlmBackend.h"
#include "doctr/DoctrBackend.h"
#include "ppocr/PpocrBackend.h"

#include <stdexcept>

namespace {

std::string CanonicalOcrModelType(const std::string& model_type) {
  if (model_type == "docvlm" || model_type == "doc-vlm" ||
      model_type == "granite-docling" || model_type == "docling") {
    return "doc_vlm";
  }
  return model_type;
}

}  // namespace

namespace sherpa_onnx {
namespace ocr {

std::unique_ptr<OcrBackend> CreateOcrBackend(const std::string& model_type) {
  const std::string type = CanonicalOcrModelType(model_type);
  if (type == "ppocr" || type == "auto") {
    return std::make_unique<ppocr::PpocrBackend>();
  }
  if (type == "doctr") {
    return std::make_unique<doctr::DoctrBackend>();
  }
  if (type == "doc_vlm") {
    return std::make_unique<doc_vlm::DocVlmBackend>();
  }
  throw std::invalid_argument(
      "Unknown OCR modelType/backend '" + model_type +
      "'. Supported in this build: ppocr, doctr, doc_vlm "
      "(aliases: docvlm, doc-vlm, granite-docling, docling; "
      "auto → ppocr when passed straight to CreateOcrBackend).");
}

}  // namespace ocr
}  // namespace sherpa_onnx
