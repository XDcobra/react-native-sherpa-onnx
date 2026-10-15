#pragma once

#include "OcrBackend.h"

#include <memory>
#include <string>

namespace sherpa_onnx {
namespace ocr {

/**
 * Create a backend for modelType.
 * Supported ids: "ppocr", "doctr", "doc_vlm", plus aliases
 * "docvlm", "doc-vlm", "granite-docling", "docling".
 * "auto" constructs PpocrBackend (detect resolves auto before this call).
 * Throws std::invalid_argument for unknown families.
 */
std::unique_ptr<OcrBackend> CreateOcrBackend(const std::string& model_type);

}  // namespace ocr
}  // namespace sherpa_onnx
