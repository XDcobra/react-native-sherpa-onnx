#ifndef SHERPA_ONNX_DIARIZATION_BRIDGE_UTILS_H
#define SHERPA_ONNX_DIARIZATION_BRIDGE_UTILS_H

#import <Foundation/Foundation.h>

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx {
namespace diarization {
namespace bridge {

NSString *DiarizationKindToNSString(sherpaonnx::DiarizationModelKind kind);

NSDictionary *DiarizationDetectResultToDict(
    const sherpaonnx::DiarizationDetectResult &result
);

std::string ModelTypeOrAuto(NSString *modelType);

}  // namespace bridge
}  // namespace diarization
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_DIARIZATION_BRIDGE_UTILS_H
