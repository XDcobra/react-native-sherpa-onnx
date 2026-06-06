#ifndef SHERPA_ONNX_VALIDATE_CUSTOM_TYPES_H
#define SHERPA_ONNX_VALIDATE_CUSTOM_TYPES_H

#include <string>
#include <vector>

namespace sherpaonnx {

struct CustomPathFieldSpec {
    std::string key;
    bool required = false;
    bool isDirectory = false;
};

struct CustomModelValidationResult {
    bool ok = true;
    std::vector<std::string> missingRequired;
    std::string error;
};

struct CustomModelPathRequirements {
    std::vector<CustomPathFieldSpec> fields;
};

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_CUSTOM_TYPES_H
