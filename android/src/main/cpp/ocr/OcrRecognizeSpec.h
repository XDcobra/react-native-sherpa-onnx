/**
 * Wire format for recognize-time knobs: one string through TS / Kotlin / ObjC.
 * `v1;family=…;task=…;…`
 */
#pragma once

#include "OcrInstruction.h"

#include <string>

namespace sherpa_onnx {
namespace ocr {

struct OcrRecognizeSpecParse {
  bool ok = false;
  std::string error_code;
  std::string error_message;
  OcrRecognizeRequest request;
  std::string family;
};

OcrRecognizeSpecParse ParseOcrRecognizeSpec(const std::string& spec);

/** Result echo / tests. Fixed key order. Empty instruction → family default. */
std::string SerializeOcrRecognizeSpec(const std::string& family,
                                      const OcrRecognizeRequest& request);

}  // namespace ocr
}  // namespace sherpa_onnx
