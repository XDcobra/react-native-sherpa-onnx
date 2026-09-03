#ifndef SHERPA_ONNX_DIARIZATION_DETECT_WRAPPER_H
#define SHERPA_ONNX_DIARIZATION_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject DiarizationDetectResultToJava(
    JNIEnv* env,
    const DiarizationDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_DIARIZATION_DETECT_WRAPPER_H
