#ifndef SHERPA_ONNX_ALIGNMENT_WRAPPER_H
#define SHERPA_ONNX_ALIGNMENT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject AlignmentDetectResultToJava(
    JNIEnv* env,
    const AlignmentDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_ALIGNMENT_WRAPPER_H
