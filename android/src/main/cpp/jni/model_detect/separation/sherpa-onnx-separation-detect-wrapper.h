#ifndef SHERPA_ONNX_SEPARATION_DETECT_WRAPPER_H
#define SHERPA_ONNX_SEPARATION_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject SeparationDetectResultToJava(
    JNIEnv* env,
    const SeparationDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_SEPARATION_DETECT_WRAPPER_H
