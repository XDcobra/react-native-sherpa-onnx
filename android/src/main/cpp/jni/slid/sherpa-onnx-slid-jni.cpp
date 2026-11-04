#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-slid-wrapper.h"
#include "jni/offline_pcm_view.h"

#include <android/log.h>
#include <jni.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define SLID_JNI_TAG "SherpaOnnx:slid"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, SLID_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, SLID_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_slid_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::SpokenLanguageIdWrapper>>
    g_slid;

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

std::vector<float> CopyFloatArray(JNIEnv* env, jfloatArray samples) {
  if (samples == nullptr) return {};
  const jsize n = env->GetArrayLength(samples);
  std::vector<float> out(static_cast<size_t>(n));
  if (n > 0) {
    env->GetFloatArrayRegion(samples, 0, n, out.data());
  }
  return out;
}

std::shared_ptr<sherpaonnx::SpokenLanguageIdWrapper> Lookup(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_slid_mutex);
  auto it = g_slid.find(id);
  if (it == g_slid.end() || !it->second) return nullptr;
  return it->second;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_slid_facade_SherpaOnnxLanguageIdHelper_nativeInitialize(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring encoder,
    jstring decoder, jint tailPaddings, jint numThreads, jstring provider,
    jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string enc = CopyRequiredJstring(env, encoder);
  const std::string dec = CopyRequiredJstring(env, decoder);
  const std::string prov = CopyRequiredJstring(env, provider);

  sherpaonnx::SlidInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_slid_mutex);
    g_slid.erase(id);
    auto inst = std::make_shared<sherpaonnx::SpokenLanguageIdWrapper>();
    result = inst->initialize(enc, dec, tailPaddings,
                              numThreads > 0 ? numThreads : 1,
                              prov.empty() ? "cpu" : prov, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitialize failed id=%s: %s", id.c_str(), result.error.c_str());
    } else {
      g_slid[id] = std::move(inst);
      LOGI("nativeInitialize ok id=%s", id.c_str());
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
Java_com_sherpaonnx_slid_facade_SherpaOnnxLanguageIdHelper_nativeCompute(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = Lookup(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "SLID instance not found");
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "LANGUAGE_ID_NOT_INITIALIZED");
    return map;
  }

  const auto pcm = CopyFloatArray(env, samples);
  const auto result =
      inst->compute(pcm.data(), static_cast<int32_t>(pcm.size()), sampleRate);
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "lang", result.lang);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  if (!result.success) {
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "LANGUAGE_ID_IDENTIFY_FAILED");
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_slid_facade_SherpaOnnxLanguageIdHelper_nativeComputeFromBuffer(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring bufferId,
    jint startSample, jint endSampleExclusive) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = Lookup(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "SLID instance not found");
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "LANGUAGE_ID_NOT_INITIALIZED");
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

  const auto result = inst->compute(
      view.count > 0 ? view.data : nullptr, static_cast<int32_t>(view.count),
      view.sampleRate);
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "lang", result.lang);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  if (!result.success) {
    sherpaonnx::PutString(env, map, mapPut, "errorCode",
                          "LANGUAGE_ID_IDENTIFY_FAILED");
  }
  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_slid_facade_SherpaOnnxLanguageIdHelper_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  return Lookup(id) != nullptr ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_slid_facade_SherpaOnnxLanguageIdHelper_nativeUnload(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::SpokenLanguageIdWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_slid_mutex);
    auto it = g_slid.find(id);
    if (it != g_slid.end()) {
      removed = std::move(it->second);
      g_slid.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_slid_facade_SherpaOnnxLanguageIdHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string,
                     std::shared_ptr<sherpaonnx::SpokenLanguageIdWrapper>>
      all;
  {
    std::lock_guard<std::mutex> lock(g_slid_mutex);
    all.swap(g_slid);
  }
  for (auto& kv : all) {
    if (kv.second) {
      kv.second->release();
    }
  }
  LOGI("nativeShutdownAll count=%zu", all.size());
}

}  // extern "C"
