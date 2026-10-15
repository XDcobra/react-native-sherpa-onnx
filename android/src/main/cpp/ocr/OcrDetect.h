#pragma once

#include <string>

namespace sherpa_onnx {
namespace ocr {

struct OcrDetectResult {
  bool ok = false;
  std::string modelType;  // concrete, e.g. "ppocr"
  std::string family;     // e.g. "ppocr"
  bool hasDet = false;
  bool hasRec = false;
  bool hasCls = false;
  bool hasRecYml = false;
  std::string errorCode;
  std::string errorMessage;
};

/**
 * Lightweight layout detect for modelType auto.
 * Recognizes ppocr pack layout (det.onnx + rec.onnx + rec_inference.yml).
 */
OcrDetectResult DetectOcrModel(const std::string& model_dir);

}  // namespace ocr
}  // namespace sherpa_onnx
