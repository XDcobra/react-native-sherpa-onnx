#pragma once

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

struct OcrDetectedModelEntry {
  std::string type;
  std::string modelDir;
};

struct OcrDetectResult {
  bool ok = false;
  std::string modelType;  // concrete, e.g. "ppocr"
  std::string family;     // e.g. "ppocr"
  bool hasDet = false;
  bool hasRec = false;
  bool hasCls = false;
  bool hasRecYml = false;
  /** Resolved relative/absolute paths when detection finds files. */
  std::string detPath;
  std::string recPath;
  std::string clsPath;
  std::string recDictPath;
  /** DetectionSource literals (fileListing, fallbackOrder, …). */
  std::vector<std::string> detectionSources;
  std::vector<OcrDetectedModelEntry> detectedModels;
  std::string quantization;
  std::string sizeTier;
  std::string errorCode;
  std::string errorMessage;
};

/**
 * Family-aware OCR pack detect (delegates to jni/model_detect/ocr).
 * Recognizes ppocr via Det+Rec+dict co-occurrence with dynamic filename tokens.
 * @param model_type `"auto"` (default) or concrete family e.g. `"ppocr"`.
 */
OcrDetectResult DetectOcrModel(const std::string& model_dir,
                               const std::string& model_type = "auto");

}  // namespace ocr
}  // namespace sherpa_onnx
