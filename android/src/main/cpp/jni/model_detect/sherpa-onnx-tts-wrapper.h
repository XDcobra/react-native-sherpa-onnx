#ifndef SHERPA_ONNX_TTS_WRAPPER_H
#define SHERPA_ONNX_TTS_WRAPPER_H

#include <jni.h>

namespace sherpaonnx {

struct TtsDetectResult;

// Converts C++ TtsDetectResult to a Java HashMap (success, error, modelType, detectedModels, paths).
// Caller must DeleteLocalRef the returned jobject.
jobject TtsDetectResultToJava(JNIEnv* env, const TtsDetectResult& result);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_TTS_WRAPPER_H
