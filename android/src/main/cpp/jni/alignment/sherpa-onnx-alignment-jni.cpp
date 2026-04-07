/**
 * JNI bridge for wav2vec2 CTC alignment (shared C++ core).
 */

#include <jni.h>
#include <string>
#include <vector>

#include "sherpa_onnx_ctc_alignment.hpp"
#include "sherpa-onnx-detect-jni-common.h"

namespace {

bool PutDouble(JNIEnv* env, jobject map, jmethodID putId, const char* key, double value) {
  jclass doubleClass = env->FindClass("java/lang/Double");
  if (!doubleClass) {
    return false;
  }
  jmethodID valueOf = env->GetStaticMethodID(doubleClass, "valueOf", "(D)Ljava/lang/Double;");
  if (!valueOf) {
    env->DeleteLocalRef(doubleClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(doubleClass, valueOf, static_cast<jdouble>(value));
  env->DeleteLocalRef(doubleClass);
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

jobject BuildAlignmentIntervalsList(
    JNIEnv* env,
    const std::vector<sherpa_onnx::ctc_alignment::AlignmentInterval>& items) {
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

jobject CtcResultToJavaHashMap(JNIEnv* env, const sherpa_onnx::ctc_alignment::CtcAlignmentResult& result) {
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

  jobject words = BuildAlignmentIntervalsList(env, result.words);
  if (words) {
    jstring k = env->NewStringUTF("words");
    if (k) {
      env->CallObjectMethod(map, mapPut, k, words);
      env->DeleteLocalRef(k);
    }
    env->DeleteLocalRef(words);
  }
  jobject chars = BuildAlignmentIntervalsList(env, result.chars);
  if (chars) {
    jstring k = env->NewStringUTF("chars");
    if (k) {
      env->CallObjectMethod(map, mapPut, k, chars);
      env->DeleteLocalRef(k);
    }
    env->DeleteLocalRef(chars);
  }
  return map;
}

}  // namespace

extern "C" JNIEXPORT jobject JNICALL Java_com_sherpaonnx_SherpaOnnxAlignmentHelper_nativeCtcAlignAccurate(
    JNIEnv* env,
    jobject /* this */,
    jstring jModelPath,
    jstring jText,
    jstring jVocabJson,
    jfloatArray jSamples,
    jint jSampleRate) {
  try {
    if (!jModelPath || !jText || !jVocabJson || !jSamples) {
      throw std::runtime_error("nativeCtcAlignAccurate: null argument");
    }
    const char* modelPathChars = env->GetStringUTFChars(jModelPath, nullptr);
    const char* textChars = env->GetStringUTFChars(jText, nullptr);
    const char* vocabChars = env->GetStringUTFChars(jVocabJson, nullptr);
    if (!modelPathChars || !textChars || !vocabChars) {
      if (modelPathChars) {
        env->ReleaseStringUTFChars(jModelPath, modelPathChars);
      }
      if (textChars) {
        env->ReleaseStringUTFChars(jText, textChars);
      }
      if (vocabChars) {
        env->ReleaseStringUTFChars(jVocabJson, vocabChars);
      }
      throw std::runtime_error("nativeCtcAlignAccurate: failed to read JNI strings");
    }
    std::string modelPath(modelPathChars);
    std::string textUtf8(textChars);
    std::string vocabJson(vocabChars);
    env->ReleaseStringUTFChars(jModelPath, modelPathChars);
    env->ReleaseStringUTFChars(jText, textChars);
    env->ReleaseStringUTFChars(jVocabJson, vocabChars);

    const jsize n = env->GetArrayLength(jSamples);
    if (n <= 0) {
      throw std::runtime_error("samples array is empty");
    }
    std::vector<float> samples(static_cast<size_t>(n));
    env->GetFloatArrayRegion(jSamples, 0, n, samples.data());

    auto result = sherpa_onnx::ctc_alignment::RunCtcAlignmentFromFloatPcm(
        modelPath,
        textUtf8,
        vocabJson,
        samples.data(),
        samples.size(),
        static_cast<int32_t>(jSampleRate));

    jobject out = CtcResultToJavaHashMap(env, result);
    if (!out) {
      throw std::runtime_error("failed to build Java alignment result");
    }
    return out;
  } catch (const std::exception& e) {
    jclass ex = env->FindClass("java/lang/RuntimeException");
    if (ex) {
      env->ThrowNew(ex, e.what());
      env->DeleteLocalRef(ex);
    }
    return nullptr;
  } catch (...) {
    jclass ex = env->FindClass("java/lang/RuntimeException");
    if (ex) {
      env->ThrowNew(ex, "CTC alignment failed");
      env->DeleteLocalRef(ex);
    }
    return nullptr;
  }
}
