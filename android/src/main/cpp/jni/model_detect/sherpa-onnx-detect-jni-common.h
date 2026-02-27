#ifndef SHERPA_ONNX_DETECT_JNI_COMMON_H
#define SHERPA_ONNX_DETECT_JNI_COMMON_H

#include <jni.h>
#include <string>
#include <vector>

#include "sherpa-onnx-common.h"

namespace sherpaonnx {

// Helpers for building Java HashMap/ArrayList from C++ detect results.
// Used by sherpa-onnx-stt-wrapper and sherpa-onnx-tts-wrapper.
bool PutString(JNIEnv* env, jobject map, jmethodID putId, const char* key, const std::string& value);
bool PutBoolean(JNIEnv* env, jobject map, jmethodID putId, const char* key, bool value);
jobject BuildDetectedModelsList(JNIEnv* env, const std::vector<DetectedModel>& models);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_DETECT_JNI_COMMON_H
