/**
 * Per-family tasks, span levels, and request validation. One table.
 */
#pragma once

#include "OcrInstruction.h"
#include "OcrTypes.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

struct OcrFamilyCapabilities {
  std::string family;
  std::vector<std::string> tasks;
  std::vector<OcrGranularity> granularities;
  bool supports_crop = true;
  bool produces_elements = false;
};

OcrFamilyCapabilities CapabilitiesForFamily(const std::string& family);

const char* GranularityName(OcrGranularity granularity);

struct OcrValidateResult {
  bool ok = false;
  std::string error_code;
  std::string error_message;
};

OcrValidateResult ValidateRequest(const std::string& family,
                                  const OcrRecognizeRequest& request,
                                  OcrGranularity granularity, int frame_w,
                                  int frame_h);

}  // namespace ocr
}  // namespace sherpa_onnx
