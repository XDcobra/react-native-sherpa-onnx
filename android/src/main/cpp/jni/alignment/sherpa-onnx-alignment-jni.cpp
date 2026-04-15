/**
 * JNI bridge for shared alignment engine (proportional / estimated / accurate).
 */

#include <jni.h>

#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "sherpa_onnx_alignment_engine.hpp"
#include "sherpa-onnx-detect-jni-common.h"

namespace {

bool PutDouble(JNIEnv* env, jobject map, jmethodID putId, const char* key, double value) {
  // Thread-safe one-time initialization of the cached Double class ref and valueOf ID.
  static std::once_flag initFlag;
  static jclass doubleClassGlobal = nullptr;
  static jmethodID valueOfId = nullptr;
  static bool initOk = false;

  std::call_once(initFlag, [&env]() {
    jclass local = env->FindClass("java/lang/Double");
    if (!local) {
      return;
    }
    doubleClassGlobal = static_cast<jclass>(env->NewGlobalRef(local));
    env->DeleteLocalRef(local);
    if (!doubleClassGlobal) {
      return;
    }
    valueOfId = env->GetStaticMethodID(doubleClassGlobal, "valueOf", "(D)Ljava/lang/Double;");
    if (!valueOfId) {
      env->DeleteGlobalRef(doubleClassGlobal);
      doubleClassGlobal = nullptr;
      return;
    }
    initOk = true;
  });

  if (!initOk || !doubleClassGlobal || !valueOfId) {
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(doubleClassGlobal, valueOfId, static_cast<jdouble>(value));
  if (!boxed) {
    return false;
  }
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

std::string JStringToUtf8(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return "";
  }
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    throw std::runtime_error("Failed to read UTF-8 string from JNI");
  }
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

std::vector<int32_t> JIntArrayToVector(JNIEnv* env, jintArray array) {
  if (array == nullptr) {
    return {};
  }
  const jsize n = env->GetArrayLength(array);
  if (n <= 0) {
    return {};
  }
  std::vector<jint> tmp(static_cast<size_t>(n));
  env->GetIntArrayRegion(array, 0, n, tmp.data());
  std::vector<int32_t> out;
  out.reserve(static_cast<size_t>(n));
  for (jint v : tmp) {
    out.push_back(static_cast<int32_t>(v));
  }
  return out;
}

jobject BuildSubtitleList(
    JNIEnv* env,
    const std::vector<sherpa_onnx::alignment::SubtitleItem>& items) {
  jclass listClass = env->FindClass("java/util/ArrayList");
  if (!listClass) {
    return nullptr;
  }
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  if (!listInit || !listAdd) {
    env->DeleteLocalRef(listClass);
    return nullptr;
  }
  jobject list = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  if (!list) {
    return nullptr;
  }

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

  for (const auto& it : items) {
    jobject row = env->NewObject(mapClass, mapInit);
    if (!row) {
      continue;
    }
    sherpaonnx::PutString(env, row, mapPut, "text", it.text);
    PutDouble(env, row, mapPut, "start", it.start_s);
    PutDouble(env, row, mapPut, "end", it.end_s);
    env->CallBooleanMethod(list, listAdd, row);
    env->DeleteLocalRef(row);
  }
  env->DeleteLocalRef(mapClass);
  return list;
}

jobject AlignmentResultToJavaHashMap(
    JNIEnv* env,
    const sherpa_onnx::alignment::AlignmentResult& result) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) {
    return nullptr;
  }
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, mapInit);
  env->DeleteLocalRef(mapClass);
  if (!map) {
    return nullptr;
  }

  jobject subtitles = BuildSubtitleList(env, result.subtitles);
  if (subtitles) {
    jstring key = env->NewStringUTF("subtitles");
    if (key) {
      env->CallObjectMethod(map, mapPut, key, subtitles);
      env->DeleteLocalRef(key);
    }
    env->DeleteLocalRef(subtitles);
  }

  sherpaonnx::PutString(env, map, mapPut, "timingMode", result.timing_mode);
  return map;
}

void ThrowRuntimeException(JNIEnv* env, const char* message) {
  jclass ex = env->FindClass("java/lang/RuntimeException");
  if (ex) {
    env->ThrowNew(ex, message != nullptr ? message : "Alignment JNI error");
    env->DeleteLocalRef(ex);
  }
}

}  // namespace

extern "C" JNIEXPORT jobject JNICALL Java_com_sherpaonnx_alignment_facade_SherpaOnnxAlignmentHelper_nativeAlignProportional(
    JNIEnv* env,
    jobject /* this */,
    jstring jText,
    jint jTotalSamples,
    jint jSampleRate,
    jstring jGranularity) {
  try {
    const std::string text = JStringToUtf8(env, jText);
    const std::string granularity = JStringToUtf8(env, jGranularity);
    auto result = sherpa_onnx::alignment::AlignProportional(
        text,
        static_cast<int32_t>(jTotalSamples),
        static_cast<int32_t>(jSampleRate),
        granularity);
    return AlignmentResultToJavaHashMap(env, result);
  } catch (const std::exception& e) {
    ThrowRuntimeException(env, e.what());
    return nullptr;
  } catch (...) {
    ThrowRuntimeException(env, "Proportional alignment failed");
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL Java_com_sherpaonnx_alignment_facade_SherpaOnnxAlignmentHelper_nativeAlignEstimated(
    JNIEnv* env,
    jobject /* this */,
    jstring jText,
    jintArray jSegmentSampleCounts,
    jint jSampleRate,
    jstring jGranularity) {
  try {
    const std::string text = JStringToUtf8(env, jText);
    const std::string granularity = JStringToUtf8(env, jGranularity);
    const std::vector<int32_t> counts = JIntArrayToVector(env, jSegmentSampleCounts);

    auto result = sherpa_onnx::alignment::AlignEstimated(
        text,
        counts,
        static_cast<int32_t>(jSampleRate),
        granularity);
    return AlignmentResultToJavaHashMap(env, result);
  } catch (const std::exception& e) {
    ThrowRuntimeException(env, e.what());
    return nullptr;
  } catch (...) {
    ThrowRuntimeException(env, "Estimated alignment failed");
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL Java_com_sherpaonnx_alignment_facade_SherpaOnnxAlignmentHelper_nativeAlignAccurateFromFloatPcm(
    JNIEnv* env,
    jobject /* this */,
    jstring jModelPath,
    jstring jText,
    jfloatArray jSamples,
    jint jSampleRate,
    jstring jGranularity) {
  try {
    if (!jModelPath || !jText || !jSamples) {
      throw std::runtime_error("nativeAlignAccurateFromFloatPcm: null argument");
    }

    const std::string modelPath = JStringToUtf8(env, jModelPath);
    const std::string text = JStringToUtf8(env, jText);
    const std::string granularity = JStringToUtf8(env, jGranularity);

    const jsize n = env->GetArrayLength(jSamples);
    if (n <= 0) {
      throw std::runtime_error("samples array is empty");
    }
    std::vector<float> samples(static_cast<size_t>(n));
    env->GetFloatArrayRegion(jSamples, 0, n, samples.data());

    auto result = sherpa_onnx::alignment::AlignAccurateFromPcm(
        modelPath,
        text,
        samples.data(),
        samples.size(),
        static_cast<int32_t>(jSampleRate),
        granularity);

    return AlignmentResultToJavaHashMap(env, result);
  } catch (const std::exception& e) {
    ThrowRuntimeException(env, e.what());
    return nullptr;
  } catch (...) {
    ThrowRuntimeException(env, "Accurate alignment (PCM) failed");
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL Java_com_sherpaonnx_alignment_facade_SherpaOnnxAlignmentHelper_nativeAlignAccurateFromFile(
    JNIEnv* env,
    jobject /* this */,
    jstring jModelPath,
    jstring jText,
    jstring jAudioPath,
    jstring jGranularity) {
  try {
    if (!jModelPath || !jText || !jAudioPath) {
      throw std::runtime_error("nativeAlignAccurateFromFile: null argument");
    }

    const std::string modelPath = JStringToUtf8(env, jModelPath);
    const std::string text = JStringToUtf8(env, jText);
    const std::string audioPath = JStringToUtf8(env, jAudioPath);
    const std::string granularity = JStringToUtf8(env, jGranularity);

    auto result = sherpa_onnx::alignment::AlignAccurateFromFile(
        modelPath,
        text,
        audioPath,
        granularity);

    return AlignmentResultToJavaHashMap(env, result);
  } catch (const std::exception& e) {
    ThrowRuntimeException(env, e.what());
    return nullptr;
  } catch (...) {
    ThrowRuntimeException(env, "Accurate alignment (file) failed");
    return nullptr;
  }
}
