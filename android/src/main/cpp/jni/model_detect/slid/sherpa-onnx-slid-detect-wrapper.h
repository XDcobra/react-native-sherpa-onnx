#ifndef SHERPA_ONNX_SLID_DETECT_WRAPPER_H
#define SHERPA_ONNX_SLID_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject LanguageIdDetectResultToJava(
    JNIEnv* env,
    const LanguageIdDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_SLID_DETECT_WRAPPER_H
