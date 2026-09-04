#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include <android/log.h>
#include <jni.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#define SE_JNI_TAG "SherpaOnnxSpeakerEmbeddingJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, SE_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, SE_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_speaker_embedding_mutex;
std::unordered_map<std::string,
                   std::unique_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper>>
    g_extractors;
std::unordered_map<std::string,
                   std::unique_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper>>
    g_managers;

std::string CopyRequiredJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

std::optional<std::string> CopyOptionalJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return std::nullopt;
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return std::nullopt;
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  if (out.empty()) return std::nullopt;
  return out;
}

bool PutInt(JNIEnv* env, jobject map, jmethodID putId, const char* key,
            jint value) {
  jclass intClass = env->FindClass("java/lang/Integer");
  if (!intClass) return false;
  jmethodID valueOf =
      env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  if (!valueOf) {
    env->DeleteLocalRef(intClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(intClass, valueOf, value);
  env->DeleteLocalRef(intClass);
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

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, mapInit);
  env->DeleteLocalRef(mapClass);
  if (!map) return nullptr;
  *outPut = mapPut;
  return map;
}

jobject InitResultToJava(
    JNIEnv* env, const sherpaonnx::SpeakerEmbeddingInitializeResult& result) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "errorCode", result.errorCode);
  sherpaonnx::PutString(env, map, mapPut, "modelType", result.modelType);
  if (result.dim > 0) {
    PutInt(env, map, mapPut, "dim", result.dim);
  }
  return map;
}

jobject OkMap(JNIEnv* env, bool ok) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "ok", ok);
  return map;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeInitializeExtractorAuto(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelDir,
    jstring modelType, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string dir = CopyRequiredJstring(env, modelDir);
  const std::string type = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::SpeakerEmbeddingInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto& inst = g_extractors[id];
    if (inst == nullptr) {
      inst = std::make_unique<sherpaonnx::SpeakerEmbeddingExtractorWrapper>();
    } else {
      inst->release();
    }
    result = inst->initialize(dir, type.empty() ? "auto" : type,
                              numThreads > 0 ? numThreads : 1, providerOpt,
                              debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeExtractorAuto failed: %s %s", result.error.c_str(),
           result.errorCode.c_str());
      g_extractors.erase(id);
    } else {
      LOGI("nativeInitializeExtractorAuto ok: id=%s dim=%d", id.c_str(),
           result.dim);
    }
  }
  return InitResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeInitializeExtractorCustom(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jobject modelPaths, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string type = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::SpeakerEmbeddingModelPaths paths;
  sherpaonnx::FillSpeakerEmbeddingModelPathsFromStringMap(
      sherpaonnx::JavaHashMapToStringMap(env, modelPaths), paths);

  sherpaonnx::SpeakerEmbeddingInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto& inst = g_extractors[id];
    if (inst == nullptr) {
      inst = std::make_unique<sherpaonnx::SpeakerEmbeddingExtractorWrapper>();
    } else {
      inst->release();
    }
    result = inst->initializeCustom(type, paths, numThreads > 0 ? numThreads : 1,
                                    providerOpt, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeExtractorCustom failed: %s", result.error.c_str());
      g_extractors.erase(id);
    }
  }
  return InitResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeComputeEmbedding(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (samples == nullptr || sampleRate <= 0) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "invalid compute args");
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "SPEAKER_EMBEDDING_INVALID_ARGUMENT");
    return map;
  }

  jsize n = env->GetArrayLength(samples);
  std::vector<float> input(static_cast<size_t>(n));
  if (n > 0) {
    env->GetFloatArrayRegion(samples, 0, n, input.data());
  }

  std::vector<float> embedding;
  std::string error;
  std::string errorCode;
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_extractors.find(id);
    if (it == g_extractors.end() || it->second == nullptr) {
      error = "Speaker embedding extractor not found: " + id;
      errorCode = "SPEAKER_EMBEDDING_NOT_INITIALIZED";
    } else {
      embedding = it->second->computeFromSamples(input, sampleRate);
      if (embedding.empty()) {
        error = it->second->lastError().empty()
                    ? "Speaker embedding compute failed"
                    : it->second->lastError();
        errorCode = it->second->lastErrorCode().empty()
                        ? "SPEAKER_EMBEDDING_COMPUTE_ERROR"
                        : it->second->lastErrorCode();
      } else {
        ok = true;
      }
    }
  }

  sherpaonnx::PutBoolean(env, map, mapPut, "success", ok);
  if (!ok) {
    sherpaonnx::PutString(env, map, mapPut, "error", error);
    sherpaonnx::PutString(env, map, mapPut, "errorCode", errorCode);
    return map;
  }

  jclass listClass = env->FindClass("java/util/ArrayList");
  jclass floatClass = env->FindClass("java/lang/Float");
  if (!listClass || !floatClass) {
    if (listClass) env->DeleteLocalRef(listClass);
    if (floatClass) env->DeleteLocalRef(floatClass);
    return map;
  }
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd =
      env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jmethodID floatValueOf =
      env->GetStaticMethodID(floatClass, "valueOf", "(F)Ljava/lang/Float;");
  jobject arr = env->NewObject(listClass, listInit);
  if (arr && listAdd && floatValueOf) {
    for (float v : embedding) {
      jobject boxed =
          env->CallStaticObjectMethod(floatClass, floatValueOf, v);
      if (boxed) {
        env->CallBooleanMethod(arr, listAdd, boxed);
        env->DeleteLocalRef(boxed);
      }
    }
    jstring key = env->NewStringUTF("embedding");
    env->CallObjectMethod(map, mapPut, key, arr);
    env->DeleteLocalRef(key);
  }
  if (arr) env->DeleteLocalRef(arr);
  env->DeleteLocalRef(listClass);
  env->DeleteLocalRef(floatClass);
  return map;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeUnloadExtractor(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
  auto it = g_extractors.find(id);
  if (it != g_extractors.end()) {
    if (it->second) it->second->release();
    g_extractors.erase(it);
  }
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeCreateManager(
    JNIEnv* env, jclass /* clazz */, jstring managerId, jint dim) {
  const std::string id = CopyRequiredJstring(env, managerId);
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto& inst = g_managers[id];
    if (inst == nullptr) {
      inst = std::make_unique<sherpaonnx::SpeakerEmbeddingManagerWrapper>();
    } else {
      inst->release();
    }
    ok = inst->create(dim);
    if (!ok) {
      g_managers.erase(id);
    }
  }
  sherpaonnx::PutBoolean(env, map, mapPut, "success", ok);
  if (!ok) {
    sherpaonnx::PutString(env, map, mapPut, "error",
                          "Failed to create speaker embedding manager");
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "SPEAKER_EMBEDDING_MANAGER_ERROR");
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerAdd(
    JNIEnv* env, jclass /* clazz */, jstring managerId, jstring name,
    jfloatArray embeddings, jint count) {
  const std::string id = CopyRequiredJstring(env, managerId);
  const std::string nameStr = CopyRequiredJstring(env, name);
  jsize n = embeddings != nullptr ? env->GetArrayLength(embeddings) : 0;
  std::vector<float> flat(static_cast<size_t>(n));
  if (n > 0) {
    env->GetFloatArrayRegion(embeddings, 0, n, flat.data());
  }
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_managers.find(id);
    if (it != g_managers.end() && it->second) {
      ok = it->second->add(nameStr, flat, count);
    }
  }
  return OkMap(env, ok);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerRemove(
    JNIEnv* env, jclass /* clazz */, jstring managerId, jstring name) {
  const std::string id = CopyRequiredJstring(env, managerId);
  const std::string nameStr = CopyRequiredJstring(env, name);
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_managers.find(id);
    if (it != g_managers.end() && it->second) {
      ok = it->second->remove(nameStr);
    }
  }
  return OkMap(env, ok);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerSearch(
    JNIEnv* env, jclass /* clazz */, jstring managerId, jfloatArray embedding,
    jfloat threshold) {
  const std::string id = CopyRequiredJstring(env, managerId);
  jsize n = embedding != nullptr ? env->GetArrayLength(embedding) : 0;
  std::vector<float> emb(static_cast<size_t>(n));
  if (n > 0) {
    env->GetFloatArrayRegion(embedding, 0, n, emb.data());
  }
  std::string name;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_managers.find(id);
    if (it != g_managers.end() && it->second) {
      name = it->second->search(emb, threshold);
    }
  }
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutString(env, map, mapPut, "name", name);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerVerify(
    JNIEnv* env, jclass /* clazz */, jstring managerId, jstring name,
    jfloatArray embedding, jfloat threshold) {
  const std::string id = CopyRequiredJstring(env, managerId);
  const std::string nameStr = CopyRequiredJstring(env, name);
  jsize n = embedding != nullptr ? env->GetArrayLength(embedding) : 0;
  std::vector<float> emb(static_cast<size_t>(n));
  if (n > 0) {
    env->GetFloatArrayRegion(embedding, 0, n, emb.data());
  }
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_managers.find(id);
    if (it != g_managers.end() && it->second) {
      ok = it->second->verify(nameStr, emb, threshold);
    }
  }
  return OkMap(env, ok);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerContains(
    JNIEnv* env, jclass /* clazz */, jstring managerId, jstring name) {
  const std::string id = CopyRequiredJstring(env, managerId);
  const std::string nameStr = CopyRequiredJstring(env, name);
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_managers.find(id);
    if (it != g_managers.end() && it->second) {
      ok = it->second->contains(nameStr);
    }
  }
  return OkMap(env, ok);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerNumSpeakers(
    JNIEnv* env, jclass /* clazz */, jstring managerId) {
  const std::string id = CopyRequiredJstring(env, managerId);
  std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
  auto it = g_managers.find(id);
  if (it == g_managers.end() || !it->second) return 0;
  return it->second->numSpeakers();
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeManagerAllSpeakerNames(
    JNIEnv* env, jclass /* clazz */, jstring managerId) {
  const std::string id = CopyRequiredJstring(env, managerId);
  std::vector<std::string> names;
  {
    std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
    auto it = g_managers.find(id);
    if (it != g_managers.end() && it->second) {
      names = it->second->allSpeakers();
    }
  }
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  jclass listClass = env->FindClass("java/util/ArrayList");
  if (!listClass) return map;
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd =
      env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jobject arr = env->NewObject(listClass, listInit);
  if (arr && listAdd) {
    for (const auto& n : names) {
      jstring js = env->NewStringUTF(n.c_str());
      if (js) {
        env->CallBooleanMethod(arr, listAdd, js);
        env->DeleteLocalRef(js);
      }
    }
    jstring key = env->NewStringUTF("names");
    env->CallObjectMethod(map, mapPut, key, arr);
    env->DeleteLocalRef(key);
  }
  if (arr) env->DeleteLocalRef(arr);
  env->DeleteLocalRef(listClass);
  return map;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeDestroyManager(
    JNIEnv* env, jclass /* clazz */, jstring managerId) {
  const std::string id = CopyRequiredJstring(env, managerId);
  std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
  auto it = g_managers.find(id);
  if (it != g_managers.end()) {
    if (it->second) it->second->release();
    g_managers.erase(it);
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_speakerembedding_facade_SherpaOnnxSpeakerEmbeddingHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
  for (auto& kv : g_extractors) {
    if (kv.second) kv.second->release();
  }
  g_extractors.clear();
  for (auto& kv : g_managers) {
    if (kv.second) kv.second->release();
  }
  g_managers.clear();
}

}  // extern "C"
