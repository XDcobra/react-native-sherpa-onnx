#pragma once

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

struct OcrDetectedModelEntry {
  std::string type;
  std::string modelDir;
};

/** Public language row mirrored from native detect (`iso6391Hint` + `id`). */
struct OcrLanguageRow {
  std::string iso6391Hint;
  std::string id;
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
  /** `ocr_manifest.json` — doctr and doc_vlm. */
  std::string manifestPath;
  /** doc_vlm octet. Empty for ppocr and doctr. */
  std::string visionEncoderPath;
  std::string visionEncoderDataPath;
  std::string embedTokensPath;
  std::string embedTokensDataPath;
  std::string decoderPath;
  std::string decoderDataPath;
  std::string tokenizerPath;
  /** DetectionSource literals (fileListing, fallbackOrder, …). */
  std::vector<std::string> detectionSources;
  std::vector<OcrDetectedModelEntry> detectedModels;
  /** Basename heuristics and/or curated pack/family language hints. */
  std::vector<OcrLanguageRow> languages;
  std::string quantization;
  std::string sizeTier;
  std::string errorCode;
  std::string errorMessage;
};

/**
 * Family-aware OCR pack detect (delegates to jni/model_detect/ocr).
 * @param model_type `"auto"` (default) or concrete family e.g. `"ppocr"`.
 * @param quantization filename preference (`auto`, `int8`, `fp16`, `q8`, …).
 */
OcrDetectResult DetectOcrModel(const std::string& model_dir,
                               const std::string& model_type = "auto",
                               const std::string& quantization = "");

}  // namespace ocr
}  // namespace sherpa_onnx
