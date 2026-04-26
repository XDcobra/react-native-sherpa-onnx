#ifndef SHERPA_ONNX_PUNCTUATION_WRAPPER_H
#define SHERPA_ONNX_PUNCTUATION_WRAPPER_H

#include "sherpa-onnx-model-detect.h"
#include <jni.h>

namespace sherpaonnx {

jobject PunctuationDetectResultToJava(
    JNIEnv* env,
    const PunctuationDetectResult& result
);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_PUNCTUATION_WRAPPER_H
