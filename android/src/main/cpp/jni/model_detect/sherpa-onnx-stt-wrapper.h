#ifndef SHERPA_ONNX_STT_WRAPPER_H
#define SHERPA_ONNX_STT_WRAPPER_H

#include <jni.h>

namespace sherpaonnx {

struct SttDetectResult;

// Converts C++ SttDetectResult to a Java HashMap (success, error, modelType, detectedModels, paths).
// Caller must DeleteLocalRef the returned jobject.
jobject SttDetectResultToJava(JNIEnv* env, const SttDetectResult& result);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_STT_WRAPPER_H
