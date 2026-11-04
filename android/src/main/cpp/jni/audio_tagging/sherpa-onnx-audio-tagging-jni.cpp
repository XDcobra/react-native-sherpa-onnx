#include "sherpa-onnx-audio-tagging-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "jni/offline_pcm_view.h"

#include <android/log.h>
#include <jni.h>

#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#define AT_JNI_TAG "SherpaOnnx:audioTagging"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, AT_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, AT_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_at_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::AudioTaggingWrapper>>
    g_at;

std::string CopyRequiredJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
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

jobject NewArrayList(JNIEnv* env, jmethodID* outAdd) {
  jclass listClass = env->FindClass("java/util/ArrayList");
  if (!listClass) return nullptr;
  jmethodID init = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID add =
      env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  if (!init || !add) {
    env->DeleteLocalRef(listClass);
    return nullptr;
  }
  jobject list = env->NewObject(listClass, init);
  env->DeleteLocalRef(listClass);
  if (!list) return nullptr;
  *outAdd = add;
  return list;
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

bool PutDouble(JNIEnv* env, jobject map, jmethodID putId, const char* key,
               jdouble value) {
  jclass dblClass = env->FindClass("java/lang/Double");
  if (!dblClass) return false;
  jmethodID valueOf =
      env->GetStaticMethodID(dblClass, "valueOf", "(D)Ljava/lang/Double;");
  if (!valueOf) {
    env->DeleteLocalRef(dblClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(dblClass, valueOf, value);
  env->DeleteLocalRef(dblClass);
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

std::vector<float> CopyFloatArray(JNIEnv* env, jfloatArray samples) {
  if (samples == nullptr) return {};
  const jsize n = env->GetArrayLength(samples);
  std::vector<float> out(static_cast<size_t>(n));
  if (n > 0) {
    env->GetFloatArrayRegion(samples, 0, n, out.data());
  }
  return out;
}

std::shared_ptr<sherpaonnx::AudioTaggingWrapper> Lookup(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_at_mutex);
  auto it = g_at.find(id);
  if (it == g_at.end() || !it->second) return nullptr;
  return it->second;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeInitialize(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jstring modelPath, jstring labelsPath, jint topK, jint numThreads,
    jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string type = CopyRequiredJstring(env, modelType);
  const std::string model = CopyRequiredJstring(env, modelPath);
  const std::string labels = CopyRequiredJstring(env, labelsPath);
  const std::string prov = CopyRequiredJstring(env, provider);

  sherpaonnx::AudioTaggingInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_at_mutex);
    g_at.erase(id);
    auto inst = std::make_shared<sherpaonnx::AudioTaggingWrapper>();
    result = inst->initialize(type, model, labels, topK > 0 ? topK : 5,
                              numThreads > 0 ? numThreads : 1,
                              prov.empty() ? "cpu" : prov, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitialize failed id=%s: %s", id.c_str(), result.error.c_str());
    } else {
      g_at[id] = std::move(inst);
      LOGI("nativeInitialize ok id=%s type=%s", id.c_str(), type.c_str());
    }
  }

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeCompute(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate, jint topK) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = Lookup(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error",
                          "Audio tagging instance not found");
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "AUDIO_TAGGING_NOT_INITIALIZED");
    return map;
  }

  const auto pcm = CopyFloatArray(env, samples);
  std::optional<int32_t> topKOpt;
  if (topK > 0) {
    topKOpt = topK;
  }
  const auto result = inst->compute(pcm.data(), static_cast<int32_t>(pcm.size()),
                                    sampleRate, topKOpt);

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  if (!result.success) {
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "AUDIO_TAGGING_TAG_FAILED");
  }

  jmethodID listAdd = nullptr;
  jobject list = NewArrayList(env, &listAdd);
  if (list) {
    for (const auto& ev : result.events) {
      jmethodID eventPut = nullptr;
      jobject eventMap = NewHashMap(env, &eventPut);
      if (!eventMap) continue;
      sherpaonnx::PutString(env, eventMap, eventPut, "name", ev.name);
      PutInt(env, eventMap, eventPut, "index", ev.index);
      PutDouble(env, eventMap, eventPut, "prob", static_cast<jdouble>(ev.prob));
      env->CallBooleanMethod(list, listAdd, eventMap);
      env->DeleteLocalRef(eventMap);
    }
    jstring key = env->NewStringUTF("events");
    env->CallObjectMethod(map, mapPut, key, list);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(list);
  }

  PutInt(env, map, mapPut, "defaultTopK", inst->defaultTopK());
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeComputeFromBuffer(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring bufferId,
    jint startSample, jint endSampleExclusive, jint topK) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = Lookup(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error",
                          "Audio tagging instance not found");
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "AUDIO_TAGGING_NOT_INITIALIZED");
    return map;
  }

  PaOfflineSampleView view;
  std::string errCode;
  std::string errMsg;
  if (!JniAcquireOfflinePcm(env, bufferId, startSample, endSampleExclusive, &view,
                            &errCode, &errMsg)) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", errMsg);
    sherpaonnx::PutString(env, map, mapPut, "errorCode", errCode);
    return map;
  }

  std::optional<int32_t> topKOpt;
  if (topK > 0) {
    topKOpt = topK;
  }
  const auto result = inst->compute(view.count > 0 ? view.data : nullptr,
                                    static_cast<int32_t>(view.count),
                                    view.sampleRate, topKOpt);

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  if (!result.success) {
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "AUDIO_TAGGING_TAG_FAILED");
  }

  jmethodID listAdd = nullptr;
  jobject list = NewArrayList(env, &listAdd);
  if (list) {
    for (const auto& ev : result.events) {
      jmethodID eventPut = nullptr;
      jobject eventMap = NewHashMap(env, &eventPut);
      if (!eventMap) continue;
      sherpaonnx::PutString(env, eventMap, eventPut, "name", ev.name);
      PutInt(env, eventMap, eventPut, "index", ev.index);
      PutDouble(env, eventMap, eventPut, "prob", static_cast<jdouble>(ev.prob));
      env->CallBooleanMethod(list, listAdd, eventMap);
      env->DeleteLocalRef(eventMap);
    }
    jstring key = env->NewStringUTF("events");
    env->CallObjectMethod(map, mapPut, key, list);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(list);
  }

  PutInt(env, map, mapPut, "defaultTopK", inst->defaultTopK());
  return map;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeDefaultTopK(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = Lookup(id);
  if (!inst) return 5;
  return inst->defaultTopK();
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  return Lookup(id) != nullptr ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeUnload(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::AudioTaggingWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_at_mutex);
    auto it = g_at.find(id);
    if (it != g_at.end()) {
      removed = std::move(it->second);
      g_at.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audiotagging_facade_SherpaOnnxAudioTaggingHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string,
                     std::shared_ptr<sherpaonnx::AudioTaggingWrapper>>
      all;
  {
    std::lock_guard<std::mutex> lock(g_at_mutex);
    all.swap(g_at);
  }
  for (auto& kv : all) {
    if (kv.second) {
      kv.second->release();
    }
  }
  LOGI("nativeShutdownAll count=%zu", all.size());
}

}  // extern "C"
