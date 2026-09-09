#ifndef SHERPA_ONNX_KWS_DETECT_WRAPPER_H
#define SHERPA_ONNX_KWS_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject KwsDetectResultToJava(JNIEnv* env, const KwsDetectResult& result);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_KWS_DETECT_WRAPPER_H
