#ifndef SHERPA_ONNX_UNIFIED_DETECT_WRAPPER_H
#define SHERPA_ONNX_UNIFIED_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect-unified.h"

namespace sherpaonnx {

jobject UnifiedDetectResultToJava(JNIEnv* env, const UnifiedModelDetectResult& result);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_UNIFIED_DETECT_WRAPPER_H
