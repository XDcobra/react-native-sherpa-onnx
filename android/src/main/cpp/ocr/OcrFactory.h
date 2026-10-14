#pragma once

#include "OcrBackend.h"

#include <memory>
#include <string>

namespace sherpa_onnx {
namespace ocr {

/**
 * Create a backend for modelType ("ppocr", …).
 * Throws std::invalid_argument for unknown families (extensibility hook).
 */
std::unique_ptr<OcrBackend> CreateOcrBackend(const std::string& model_type);

}  // namespace ocr
}  // namespace sherpa_onnx
