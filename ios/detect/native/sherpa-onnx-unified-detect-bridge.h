#ifndef SHERPA_ONNX_UNIFIED_DETECT_BRIDGE_H
#define SHERPA_ONNX_UNIFIED_DETECT_BRIDGE_H

#import <Foundation/Foundation.h>

#include "sherpa-onnx-model-detect-unified.h"

namespace sherpaonnx {
namespace detect {
namespace bridge {

NSDictionary *UnifiedDetectResultToDict(const UnifiedModelDetectResult &result);

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_UNIFIED_DETECT_BRIDGE_H
