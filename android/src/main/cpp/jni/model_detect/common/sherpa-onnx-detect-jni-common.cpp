/**
 * sherpa-onnx-detect-jni-common.cpp
 *
 * Purpose: Shared JNI helpers for building Java HashMap/ArrayList from C++ detect results
 * (PutString, PutBoolean, BuildDetectedModelsList). Used by sherpa-onnx-stt-wrapper and
 * sherpa-onnx-tts-wrapper.
 */
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-detect-helper.h"

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

jobject BuildStringList(JNIEnv* env, const std::vector<std::string>& strings) {
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
  for (const auto& s : strings) {
    jstring jval = env->NewStringUTF(s.c_str());
    if (jval) {
      env->CallBooleanMethod(list, listAdd, jval);
      env->DeleteLocalRef(jval);
    }
  }
  return list;
}

jobject BuildLexiconLanguagesList(
    JNIEnv* env,
    const std::vector<model_detect::LexiconCandidate>& languages) {
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

  for (const auto& lang : languages) {
    jobject entry = env->NewObject(mapClass, mapInit);
    if (!entry) continue;
    PutString(env, entry, mapPut, "id", lang.languageId);
    PutString(env, entry, mapPut, "path", lang.path);
    env->CallBooleanMethod(list, listAdd, entry);
    env->DeleteLocalRef(entry);
  }
  env->DeleteLocalRef(mapClass);
  return list;
}

std::map<std::string, std::string> JavaHashMapToStringMap(JNIEnv* env, jobject map) {
  std::map<std::string, std::string> out;
  if (!map) return out;

  jclass mapClass = env->FindClass("java/util/Map");
  jclass entryClass = env->FindClass("java/util/Map$Entry");
  jclass setClass = env->FindClass("java/util/Set");
  if (!mapClass || !entryClass || !setClass) return out;

  jmethodID entrySet = env->GetMethodID(mapClass, "entrySet", "()Ljava/util/Set;");
  jmethodID setIterator = env->GetMethodID(setClass, "iterator", "()Ljava/util/Iterator;");
  jclass iteratorClass = env->FindClass("java/util/Iterator");
  jmethodID iteratorHasNext = env->GetMethodID(iteratorClass, "hasNext", "()Z");
  jmethodID iteratorNext = env->GetMethodID(iteratorClass, "next", "()Ljava/lang/Object;");
  jmethodID entryGetKey = env->GetMethodID(entryClass, "getKey", "()Ljava/lang/Object;");
  jmethodID entryGetValue = env->GetMethodID(entryClass, "getValue", "()Ljava/lang/Object;");

  if (!entrySet || !setIterator || !iteratorHasNext || !iteratorNext ||
      !entryGetKey || !entryGetValue) {
    env->DeleteLocalRef(mapClass);
    env->DeleteLocalRef(entryClass);
    env->DeleteLocalRef(setClass);
    env->DeleteLocalRef(iteratorClass);
    return out;
  }

  jobject entries = env->CallObjectMethod(map, entrySet);
  if (!entries) {
    env->DeleteLocalRef(mapClass);
    env->DeleteLocalRef(entryClass);
    env->DeleteLocalRef(setClass);
    env->DeleteLocalRef(iteratorClass);
    return out;
  }

  jobject it = env->CallObjectMethod(entries, setIterator);
  env->DeleteLocalRef(entries);
  if (!it) {
    env->DeleteLocalRef(mapClass);
    env->DeleteLocalRef(entryClass);
    env->DeleteLocalRef(setClass);
    env->DeleteLocalRef(iteratorClass);
    return out;
  }

  while (env->CallBooleanMethod(it, iteratorHasNext)) {
    jobject entry = env->CallObjectMethod(it, iteratorNext);
    if (!entry) continue;
    jstring jkey = static_cast<jstring>(env->CallObjectMethod(entry, entryGetKey));
    jstring jval = static_cast<jstring>(env->CallObjectMethod(entry, entryGetValue));
    if (jkey && jval) {
      const char* keyChars = env->GetStringUTFChars(jkey, nullptr);
      const char* valChars = env->GetStringUTFChars(jval, nullptr);
      if (keyChars && valChars && valChars[0] != '\0') {
        out.emplace(keyChars, valChars);
      }
      if (keyChars) env->ReleaseStringUTFChars(jkey, keyChars);
      if (valChars) env->ReleaseStringUTFChars(jval, valChars);
    }
    if (jkey) env->DeleteLocalRef(jkey);
    if (jval) env->DeleteLocalRef(jval);
    env->DeleteLocalRef(entry);
  }

  env->DeleteLocalRef(it);
  env->DeleteLocalRef(mapClass);
  env->DeleteLocalRef(entryClass);
  env->DeleteLocalRef(setClass);
  env->DeleteLocalRef(iteratorClass);
  return out;
}

jobject BuildCustomValidationResultMap(
    JNIEnv* env,
    const CustomModelValidationResult& result
) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(
      mapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }

  jobject map = env->NewObject(mapClass, mapInit);
  env->DeleteLocalRef(mapClass);
  if (!map) return nullptr;

  PutBoolean(env, map, mapPut, "ok", result.ok);
  if (!result.error.empty()) {
    PutString(env, map, mapPut, "error", result.error);
  }
  if (!result.missingRequired.empty()) {
    jobject missing = BuildStringList(env, result.missingRequired);
    if (missing) {
      jstring jkey = env->NewStringUTF("missingRequired");
      if (jkey) {
        env->CallObjectMethod(map, mapPut, jkey, missing);
        env->DeleteLocalRef(jkey);
      }
      env->DeleteLocalRef(missing);
    }
  }
  return map;
}

jobject BuildCustomPathRequirementsMap(
    JNIEnv* env,
    const CustomModelPathRequirements& requirements
) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(
      mapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }

  jobject map = env->NewObject(mapClass, mapInit);
  env->DeleteLocalRef(mapClass);
  if (!map) return nullptr;

  jobject required = BuildStringList(env, requirements.required);
  if (required) {
    jstring jkey = env->NewStringUTF("required");
    if (jkey) {
      env->CallObjectMethod(map, mapPut, jkey, required);
      env->DeleteLocalRef(jkey);
    }
    env->DeleteLocalRef(required);
  }

  jobject optional = BuildStringList(env, requirements.optional);
  if (optional) {
    jstring jkey = env->NewStringUTF("optional");
    if (jkey) {
      env->CallObjectMethod(map, mapPut, jkey, optional);
      env->DeleteLocalRef(jkey);
    }
    env->DeleteLocalRef(optional);
  }

  return map;
}

}  // namespace sherpaonnx
