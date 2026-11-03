#include "sherpa-onnx-vad-engine-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"

#include <android/log.h>
#include <jni.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define VAD_JNI_TAG "SherpaOnnx:vad"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, VAD_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, VAD_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_vad_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::VadEngineWrapper>>
    g_vad;

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
  env->CallObjectMethod(map, putId, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  return true;
}

std::shared_ptr<sherpaonnx::VadEngineWrapper> Lookup(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  auto it = g_vad.find(id);
  if (it == g_vad.end()) return nullptr;
  return it->second;
}

std::vector<float> CopyFloatArray(JNIEnv* env, jfloatArray arr) {
  std::vector<float> out;
  if (arr == nullptr) return out;
  const jsize n = env->GetArrayLength(arr);
  if (n <= 0) return out;
  out.resize(static_cast<size_t>(n));
  env->GetFloatArrayRegion(arr, 0, n, out.data());
  return out;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeInitialize(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jstring modelPath, jint sampleRate, jint numThreads, jstring provider,
    jboolean debug, jdouble threshold, jint minSilenceMs, jint minSpeechMs,
    jint maxSpeechMs, jint windowSize, jfloat bufferSizeSeconds) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string type = CopyRequiredJstring(env, modelType);
  const std::string model = CopyRequiredJstring(env, modelPath);
  const std::string prov = CopyRequiredJstring(env, provider);

  sherpaonnx::VadEngineConfig cfg;
  cfg.modelType = type;
  cfg.modelPath = model;
  cfg.sampleRate = sampleRate > 0 ? sampleRate : 16000;
  cfg.numThreads = numThreads > 0 ? numThreads : 1;
  cfg.provider = prov.empty() ? "cpu" : prov;
  cfg.debug = debug == JNI_TRUE;
  cfg.scoreThreshold = threshold;
  cfg.minSilenceDurationMs = minSilenceMs;
  cfg.minSpeechDurationMs = minSpeechMs;
  cfg.maxSpeechDurationMs = maxSpeechMs;
  cfg.windowSize = windowSize > 0 ? windowSize : 512;
  cfg.bufferSizeSeconds = bufferSizeSeconds > 0.f ? bufferSizeSeconds : 30.f;

  sherpaonnx::VadEngineInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    g_vad.erase(id);
    auto inst = std::make_shared<sherpaonnx::VadEngineWrapper>();
    result = inst->initialize(cfg);
    if (!result.success) {
      LOGE("nativeInitialize failed id=%s: %s", id.c_str(),
           result.error.c_str());
    } else {
      g_vad[id] = std::move(inst);
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

JNIEXPORT void JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeAcceptWaveform(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = Lookup(id);
  if (!inst) return;
  const auto pcm = CopyFloatArray(env, samples);
  if (!pcm.empty()) {
    inst->acceptWaveform(pcm.data(), static_cast<int32_t>(pcm.size()));
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeFlush(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (inst) inst->flush();
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeReset(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (inst) inst->reset();
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeIsSpeechDetected(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (!inst) return JNI_FALSE;
  return inst->isSpeechDetected() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativePopSegments(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  jmethodID listAdd = nullptr;
  jobject list = NewArrayList(env, &listAdd);
  if (!list) return nullptr;
  if (!inst) return list;

  const auto segments = inst->popSegments();
  for (const auto& seg : segments) {
    jmethodID mapPut = nullptr;
    jobject map = NewHashMap(env, &mapPut);
    if (!map) continue;
    PutInt(env, map, mapPut, "startSample", seg.startSample);
    PutInt(env, map, mapPut, "endSample", seg.endSample);
    PutInt(env, map, mapPut, "durationMs", seg.durationMs);
    env->CallBooleanMethod(list, listAdd, map);
    env->DeleteLocalRef(map);
  }
  return list;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  return Lookup(CopyRequiredJstring(env, instanceId)) != nullptr ? JNI_TRUE
                                                                 : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeUnload(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::VadEngineWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad.find(id);
    if (it != g_vad.end()) {
      removed = std::move(it->second);
      g_vad.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_vad_facade_SherpaOnnxVadHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string, std::shared_ptr<sherpaonnx::VadEngineWrapper>>
      all;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    all.swap(g_vad);
  }
  for (auto& kv : all) {
    if (kv.second) kv.second->release();
  }
  LOGI("nativeShutdownAll count=%zu", all.size());
}

}  // extern "C"
