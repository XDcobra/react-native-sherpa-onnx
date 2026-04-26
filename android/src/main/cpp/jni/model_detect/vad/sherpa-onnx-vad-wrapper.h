#ifndef SHERPA_ONNX_VAD_WRAPPER_H
#define SHERPA_ONNX_VAD_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject VadDetectResultToJava(
    JNIEnv* env,
    const VadDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_VAD_WRAPPER_H
