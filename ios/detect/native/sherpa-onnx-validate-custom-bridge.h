#ifndef SHERPA_ONNX_VALIDATE_CUSTOM_BRIDGE_H
#define SHERPA_ONNX_VALIDATE_CUSTOM_BRIDGE_H

#import <Foundation/Foundation.h>

#include "sherpa-onnx-validate-custom-types.h"

namespace sherpaonnx {
namespace detect {
namespace bridge {

NSDictionary *CustomValidationResultToDict(const CustomModelValidationResult &result);
NSDictionary *CustomPathRequirementsToDict(const CustomModelPathRequirements &requirements);

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_VALIDATE_CUSTOM_BRIDGE_H
