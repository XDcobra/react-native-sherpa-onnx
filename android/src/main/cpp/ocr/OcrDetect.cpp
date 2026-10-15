#include "OcrDetect.h"

#include <filesystem>

namespace fs = std::filesystem;

namespace sherpa_onnx {
namespace ocr {

OcrDetectResult DetectOcrModel(const std::string& model_dir) {
  OcrDetectResult out;
  if (model_dir.empty()) {
    out.errorCode = "OCR_INVALID_ARGUMENT";
    out.errorMessage = "modelDir is empty";
    return out;
  }
  if (!fs::is_directory(model_dir)) {
    out.errorCode = "OCR_MODEL_NOT_FOUND";
    out.errorMessage = "modelDir is not a directory: " + model_dir;
    return out;
  }

  const fs::path root(model_dir);
  out.hasDet = fs::exists(root / "det.onnx");
  out.hasRec = fs::exists(root / "rec.onnx");
  out.hasCls = fs::exists(root / "cls.onnx");
  out.hasRecYml = fs::exists(root / "rec_inference.yml");

  if (out.hasDet && out.hasRec && out.hasRecYml) {
    out.ok = true;
    out.modelType = "ppocr";
    out.family = "ppocr";
    return out;
  }

  out.errorCode = "OCR_DETECT_FAILED";
  out.errorMessage =
      "Unrecognized OCR pack layout (need det.onnx, rec.onnx, rec_inference.yml): " +
      model_dir;
  return out;
}

}  // namespace ocr
}  // namespace sherpa_onnx
