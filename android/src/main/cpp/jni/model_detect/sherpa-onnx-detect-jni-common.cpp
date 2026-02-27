/**
 * sherpa-onnx-detect-jni-common.cpp
 *
 * Purpose: Shared JNI helpers for building Java HashMap/ArrayList from C++ detect results
 * (PutString, PutBoolean, BuildDetectedModelsList). Used by sherpa-onnx-stt-wrapper and
 * sherpa-onnx-tts-wrapper.
 */
#include "sherpa-onnx-detect-jni-common.h"

namespace sherpaonnx {

bool PutString(JNIEnv* env, jobject map, jmethodID putId, const char* key, const std::string& value) {
  jstring jkey = env->NewStringUTF(key);
  if (!jkey) return false;
  jstring jval = value.empty() ? nullptr : env->NewStringUTF(value.c_str());
  if (!value.empty() && !jval) {
    env->DeleteLocalRef(jkey);
    return false;
  }
  env->CallObjectMethod(map, putId, jkey, jval ? static_cast<jobject>(jval) : nullptr);
  env->DeleteLocalRef(jkey);
  if (jval) env->DeleteLocalRef(jval);
  return true;
}

bool PutBoolean(JNIEnv* env, jobject map, jmethodID putId, const char* key, bool value) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  if (!boolClass) return false;
  jmethodID valueOf = env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  if (!valueOf) {
    env->DeleteLocalRef(boolClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, value ? JNI_TRUE : JNI_FALSE);
  env->DeleteLocalRef(boolClass);
  if (!boxed) return false;
  jstring jkey = env->NewStringUTF(key);
  if (!jkey) {
    env->DeleteLocalRef(boxed);
    return false;
  }
  env->CallObjectMethod(map, putId, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  return true;
}

jobject BuildDetectedModelsList(JNIEnv* env, const std::vector<DetectedModel>& models) {
  jclass listClass = env->FindClass("java/util/ArrayList");
  if (!listClass) return nullptr;
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  if (!listInit || !listAdd) {
    env->DeleteLocalRef(listClass);
    return nullptr;
  }
  jobject list = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  if (!list) return nullptr;

  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) {
    env->DeleteLocalRef(list);
    return nullptr;
  }
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    env->DeleteLocalRef(list);
    return nullptr;
  }

  for (const auto& m : models) {
    jobject modelMap = env->NewObject(mapClass, mapInit);
    if (!modelMap) continue;
    PutString(env, modelMap, mapPut, "type", m.type);
    PutString(env, modelMap, mapPut, "modelDir", m.modelDir);
    env->CallBooleanMethod(list, listAdd, modelMap);
    env->DeleteLocalRef(modelMap);
  }
  env->DeleteLocalRef(mapClass);
  return list;
}

}  // namespace sherpaonnx
