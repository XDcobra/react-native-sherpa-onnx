#ifndef SHERPA_ONNX_VALIDATE_CUSTOM_H
#define SHERPA_ONNX_VALIDATE_CUSTOM_H

#include "sherpa-onnx-validate-custom-types.h"
#include <map>
#include <string>

namespace sherpaonnx {

CustomModelValidationResult ValidateCustomModelPaths(
    const std::string& category,
    const std::string& modelType,
    const std::map<std::string, std::string>& paths,
    const std::string& contextLabel = "custom"
);

CustomModelPathRequirements GetCustomModelPathRequirements(
    const std::string& category,
    const std::string& modelType
);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_CUSTOM_H
