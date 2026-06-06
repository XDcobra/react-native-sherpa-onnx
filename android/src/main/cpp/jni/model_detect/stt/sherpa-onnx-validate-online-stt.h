#ifndef SHERPA_ONNX_VALIDATE_ONLINE_STT_H
#define SHERPA_ONNX_VALIDATE_ONLINE_STT_H

#include "sherpa-onnx-validate-custom-types.h"
#include <string>
#include <vector>

namespace sherpaonnx {

enum class OnlineSttModelKind {
  kUnknown = 0,
  kTransducer,
  kNemoTransducer,
  kParaformer,
  kZipformer2Ctc,
  kNemoCtc,
  kToneCtc,
};

struct OnlineSttModelPaths {
  std::string encoder;
  std::string decoder;
  std::string joiner;
  std::string tokens;
  /** Single ONNX for zipformer2_ctc / nemo_ctc / tone_ctc streaming models. */
  std::string model;
};

struct OnlineSttValidationResult {
  bool ok = true;
  std::vector<std::string> missingRequired;
  std::string error;
};

OnlineSttModelKind ParseOnlineSttModelType(const std::string& modelType);

OnlineSttValidationResult ValidateOnlineSttPaths(
    OnlineSttModelKind kind,
    const OnlineSttModelPaths& paths,
    const std::string& contextLabel
);

std::vector<CustomPathFieldSpec> GetOnlineSttPathRequirements(OnlineSttModelKind kind);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_ONLINE_STT_H
