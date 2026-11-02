#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-enhancement-wrapper.h"
#include "sherpa-onnx-model-path-fill.h"

#include <android/log.h>
#include <jni.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#define ENH_JNI_TAG "SherpaOnnxEnhancementJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, ENH_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, ENH_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_enhancement_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::EnhancementWrapper>>
    g_offline;
std::unordered_map<std::string,
                   std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper>>
    g_online;

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
    JNIEnv* env, const sherpaonnx::EnhancementInitializeResult& result) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "modelType", result.modelType);
  if (result.sampleRate > 0) {
    PutInt(env, map, mapPut, "sampleRate", result.sampleRate);
  }
  if (result.frameShiftInSamples > 0) {
    PutInt(env, map, mapPut, "frameShiftInSamples", result.frameShiftInSamples);
  }
  jobject detected = sherpaonnx::BuildDetectedModelsList(env, result.detectedModels);
  if (detected) {
    jstring key = env->NewStringUTF("detectedModels");
    env->CallObjectMethod(map, mapPut, key, detected);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(detected);
  }
  return map;
}

jobject AudioResultToJava(JNIEnv* env, const sherpaonnx::EnhancedAudioResult& audio,
                          bool found, const std::string& missingError) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  if (!found) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", missingError);
    return map;
  }
  sherpaonnx::PutBoolean(env, map, mapPut, "success", true);
  if (audio.sampleRate > 0) {
    PutInt(env, map, mapPut, "sampleRate", audio.sampleRate);
  }
  jfloatArray samples = env->NewFloatArray(static_cast<jsize>(audio.samples.size()));
  if (samples) {
    if (!audio.samples.empty()) {
      env->SetFloatArrayRegion(samples, 0, static_cast<jsize>(audio.samples.size()),
                               audio.samples.data());
    }
    jstring key = env->NewStringUTF("samples");
    env->CallObjectMethod(map, mapPut, key, samples);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(samples);
  }
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

std::shared_ptr<sherpaonnx::EnhancementWrapper> LookupOffline(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_enhancement_mutex);
  auto it = g_offline.find(id);
  if (it == g_offline.end() || !it->second) return nullptr;
  return it->second;
}

std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> LookupOnline(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_enhancement_mutex);
  auto it = g_online.find(id);
  if (it == g_online.end() || !it->second) return nullptr;
  return it->second;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeInitializeOfflineAuto(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelDir,
    jstring modelType, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string dir = CopyRequiredJstring(env, modelDir);
  const std::string type = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::EnhancementInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto inst = std::make_shared<sherpaonnx::EnhancementWrapper>();
    result = inst->initialize(dir, type.empty() ? "auto" : type,
                              numThreads > 0 ? numThreads : 1, providerOpt,
                              debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeOfflineAuto failed: %s", result.error.c_str());
      g_offline.erase(id);
    } else {
      g_offline[id] = std::move(inst);
      LOGI("nativeInitializeOfflineAuto ok: id=%s sr=%d", id.c_str(),
           result.sampleRate);
    }
  }
  return InitResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeInitializeOfflineCustom(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jobject modelPaths, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string type = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::EnhancementModelPaths paths;
  sherpaonnx::FillEnhancementModelPathsFromStringMap(
      sherpaonnx::JavaHashMapToStringMap(env, modelPaths), paths);

  sherpaonnx::EnhancementInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto inst = std::make_shared<sherpaonnx::EnhancementWrapper>();
    result = inst->initializeCustom(type, paths, numThreads > 0 ? numThreads : 1,
                                    providerOpt, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeOfflineCustom failed: %s", result.error.c_str());
      g_offline.erase(id);
    } else {
      g_offline[id] = std::move(inst);
      LOGI("nativeInitializeOfflineCustom ok: id=%s sr=%d", id.c_str(),
           result.sampleRate);
    }
  }
  return InitResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeInitializeOnlineAuto(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelDir,
    jstring modelType, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string dir = CopyRequiredJstring(env, modelDir);
  const std::string type = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::EnhancementInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto inst = std::make_shared<sherpaonnx::OnlineEnhancementWrapper>();
    result = inst->initialize(dir, type.empty() ? "auto" : type,
                              numThreads > 0 ? numThreads : 1, providerOpt,
                              debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeOnlineAuto failed: %s", result.error.c_str());
      g_online.erase(id);
    } else {
      g_online[id] = std::move(inst);
      LOGI("nativeInitializeOnlineAuto ok: id=%s sr=%d shift=%d", id.c_str(),
           result.sampleRate, result.frameShiftInSamples);
    }
  }
  return InitResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeInitializeOnlineCustom(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jobject modelPaths, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string type = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::EnhancementModelPaths paths;
  sherpaonnx::FillEnhancementModelPathsFromStringMap(
      sherpaonnx::JavaHashMapToStringMap(env, modelPaths), paths);

  sherpaonnx::EnhancementInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto inst = std::make_shared<sherpaonnx::OnlineEnhancementWrapper>();
    result = inst->initializeCustom(type, paths, numThreads > 0 ? numThreads : 1,
                                    providerOpt, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeOnlineCustom failed: %s", result.error.c_str());
      g_online.erase(id);
    } else {
      g_online[id] = std::move(inst);
      LOGI("nativeInitializeOnlineCustom ok: id=%s sr=%d shift=%d", id.c_str(),
           result.sampleRate, result.frameShiftInSamples);
    }
  }
  return InitResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeSetVoiceSample(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  auto write = [&](bool success, const std::string& error) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", success);
    if (!error.empty()) {
      sherpaonnx::PutString(env, map, mapPut, "error", error);
    }
  };

  const std::vector<float> pcm = CopyFloatArray(env, samples);
  if (auto offline = LookupOffline(id)) {
    const auto result = offline->setVoiceSample(pcm, sampleRate);
    write(result.success, result.error);
    return map;
  }
  if (auto online = LookupOnline(id)) {
    const auto result = online->setVoiceSample(pcm, sampleRate);
    write(result.success, result.error);
    return map;
  }
  write(false, "Enhancement instance not found: " + id);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeOfflineRun(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = LookupOffline(id);
  if (!inst) {
    return AudioResultToJava(env, {}, false,
                             "Enhancement instance not found: " + id);
  }
  return AudioResultToJava(env, inst->runSamples(CopyFloatArray(env, samples),
                                                 sampleRate),
                           true, {});
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeOnlineRun(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = LookupOnline(id);
  if (!inst) {
    return AudioResultToJava(
        env, {}, false, "Online enhancement instance not found: " + id);
  }
  return AudioResultToJava(env, inst->runSamples(CopyFloatArray(env, samples),
                                                 sampleRate),
                           true, {});
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeOnlineFlush(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = LookupOnline(id);
  if (!inst) {
    return AudioResultToJava(
        env, {}, false, "Online enhancement instance not found: " + id);
  }
  return AudioResultToJava(env, inst->flush(), true, {});
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeOnlineReset(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = LookupOnline(id);
  if (inst) {
    inst->reset();
  }
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeGetSampleRate(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  if (auto offline = LookupOffline(id)) {
    return offline->getSampleRate();
  }
  if (auto online = LookupOnline(id)) {
    return online->getSampleRate();
  }
  return 0;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeGetFrameShift(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  auto inst = LookupOnline(id);
  if (!inst) return 0;
  return inst->getFrameShiftInSamples();
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeUnloadOffline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::EnhancementWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_offline.find(id);
    if (it != g_offline.end()) {
      doomed = std::move(it->second);
      g_offline.erase(it);
    }
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeUnloadOnline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_online.find(id);
    if (it != g_online.end()) {
      doomed = std::move(it->second);
      g_online.erase(it);
    }
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_enhancement_facade_SherpaOnnxEnhancementHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::lock_guard<std::mutex> lock(g_enhancement_mutex);
  g_offline.clear();
  g_online.clear();
}

}  // extern "C"
