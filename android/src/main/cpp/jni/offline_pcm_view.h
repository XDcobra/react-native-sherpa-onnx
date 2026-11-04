#pragma once

#include "AudioRegistry.h"

#include <jni.h>

#include <string>

/** UTF-8 copy of a JNI string. Empty when value is null. */
inline std::string JniOfflineBufferId(JNIEnv* env, jstring value) {
  if (value == nullptr || env == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

/** startSample/endSampleExclusive: both < 0 means the full offline buffer. */
inline bool JniAcquireOfflinePcm(JNIEnv* env, jstring bufferId, jint startSample,
                                 jint endSampleExclusive, PaOfflineSampleView* out,
                                 std::string* errorCode, std::string* errorMessage) {
  const std::string id = JniOfflineBufferId(env, bufferId);
  if (id.empty()) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "bufferId is required";
    return false;
  }
  return pa_acquire_offline_sample_view(id, static_cast<int>(startSample),
                                        static_cast<int>(endSampleExclusive), out, errorCode,
                                        errorMessage);
}
