#pragma once

#ifdef __OBJC__
@class NSString;
@class NSDictionary;
#elif defined(__cplusplus)
class NSString;
class NSDictionary;
#else
typedef struct NSString NSString;
typedef struct NSDictionary NSDictionary;
#endif

#ifdef __cplusplus

#include "../../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx {
namespace punctuation {
namespace bridge {

NSString *PunctuationKindToNSString(sherpaonnx::PunctuationModelKind kind);
NSDictionary *PunctuationDetectResultToDict(const sherpaonnx::PunctuationDetectResult& result);
std::string ModelTypeOrAuto(NSString *modelType);

}  // namespace bridge
}  // namespace punctuation
}  // namespace sherpaonnx

#endif
