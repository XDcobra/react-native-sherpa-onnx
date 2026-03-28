#ifndef SHERPA_ONNX_ENHANCEMENT_WRAPPER_H
#define SHERPA_ONNX_ENHANCEMENT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject EnhancementDetectResultToJava(
    JNIEnv* env,
    const EnhancementDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_ENHANCEMENT_WRAPPER_H
