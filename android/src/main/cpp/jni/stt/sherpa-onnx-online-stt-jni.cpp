#include "sherpa-onnx-online-stt-engine-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-path-fill.h"

#include <android/log.h>
#include <jni.h>

#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define ONLINE_STT_JNI_TAG "SherpaOnnx:online-stt"
#define LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, ONLINE_STT_JNI_TAG, __VA_ARGS__)
#define LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, ONLINE_STT_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_online_stt_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::OnlineSttWrapper>>
    g_online_stt;

std::string CopyJstring(JNIEnv* env, jstring value) {
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

std::map<std::string, std::string> HashMapToStringMap(JNIEnv* env,
                                                      jobject map) {
  std::map<std::string, std::string> out;
  if (map == nullptr) return out;
  jclass mapClass = env->GetObjectClass(map);
  jmethodID entrySet =
      env->GetMethodID(mapClass, "entrySet", "()Ljava/util/Set;");
  jobject set = env->CallObjectMethod(map, entrySet);
  jclass setClass = env->GetObjectClass(set);
  jmethodID iterator =
      env->GetMethodID(setClass, "iterator", "()Ljava/util/Iterator;");
  jobject iter = env->CallObjectMethod(set, iterator);
  jclass iterClass = env->GetObjectClass(iter);
  jmethodID hasNext = env->GetMethodID(iterClass, "hasNext", "()Z");
  jmethodID next =
      env->GetMethodID(iterClass, "next", "()Ljava/lang/Object;");
  jclass entryClass = env->FindClass("java/util/Map$Entry");
  jmethodID getKey =
      env->GetMethodID(entryClass, "getKey", "()Ljava/lang/Object;");
  jmethodID getValue =
      env->GetMethodID(entryClass, "getValue", "()Ljava/lang/Object;");
  while (env->CallBooleanMethod(iter, hasNext)) {
    jobject entry = env->CallObjectMethod(iter, next);
    auto keyObj = static_cast<jstring>(env->CallObjectMethod(entry, getKey));
    auto valObj =
        static_cast<jstring>(env->CallObjectMethod(entry, getValue));
    out[CopyJstring(env, keyObj)] = CopyJstring(env, valObj);
    env->DeleteLocalRef(entry);
  }
  return out;
}

std::shared_ptr<sherpaonnx::OnlineSttWrapper> Lookup(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_online_stt_mutex);
  auto it = g_online_stt.find(id);
  if (it == g_online_stt.end()) return nullptr;
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

jobject InitResultMap(JNIEnv* env, const sherpaonnx::OnlineSttInitResult& result) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  return map;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeInitialize(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelDir,
    jstring modelType, jboolean enableEndpoint, jstring decodingMethod,
    jint maxActivePaths, jstring hotwordsFile, jfloat hotwordsScore,
    jint numThreads, jstring provider, jstring ruleFsts, jstring ruleFars,
    jfloat dither, jfloat blankPenalty, jboolean debug,
    jboolean rule1MustContainNonSilence, jfloat rule1MinTrailingSilence,
    jfloat rule1MinUtteranceLength, jboolean rule2MustContainNonSilence,
    jfloat rule2MinTrailingSilence, jfloat rule2MinUtteranceLength,
    jboolean rule3MustContainNonSilence, jfloat rule3MinTrailingSilence,
    jfloat rule3MinUtteranceLength) {
  const std::string id = CopyJstring(env, instanceId);
  sherpaonnx::OnlineSttInitResult result;
  {
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    g_online_stt.erase(id);
    auto inst = std::make_shared<sherpaonnx::OnlineSttWrapper>();
    result = inst->initialize(
        CopyJstring(env, modelDir), CopyJstring(env, modelType),
        enableEndpoint == JNI_TRUE, CopyJstring(env, decodingMethod),
        maxActivePaths, CopyJstring(env, hotwordsFile), hotwordsScore,
        numThreads, CopyJstring(env, provider), CopyJstring(env, ruleFsts),
        CopyJstring(env, ruleFars), dither, blankPenalty, debug == JNI_TRUE,
        rule1MustContainNonSilence == JNI_TRUE, rule1MinTrailingSilence,
        rule1MinUtteranceLength, rule2MustContainNonSilence == JNI_TRUE,
        rule2MinTrailingSilence, rule2MinUtteranceLength,
        rule3MustContainNonSilence == JNI_TRUE, rule3MinTrailingSilence,
        rule3MinUtteranceLength);
    if (result.success) {
      g_online_stt[id] = std::move(inst);
      LOGI("nativeInitialize ok id=%s", id.c_str());
    } else {
      LOGE("nativeInitialize failed id=%s: %s", id.c_str(),
           result.error.c_str());
    }
  }
  return InitResultMap(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeInitializeCustom(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jobject pathsMap, jboolean enableEndpoint, jstring decodingMethod,
    jint maxActivePaths, jstring hotwordsFile, jfloat hotwordsScore,
    jint numThreads, jstring provider, jstring ruleFsts, jstring ruleFars,
    jfloat dither, jfloat blankPenalty, jboolean debug,
    jboolean rule1MustContainNonSilence, jfloat rule1MinTrailingSilence,
    jfloat rule1MinUtteranceLength, jboolean rule2MustContainNonSilence,
    jfloat rule2MinTrailingSilence, jfloat rule2MinUtteranceLength,
    jboolean rule3MustContainNonSilence, jfloat rule3MinTrailingSilence,
    jfloat rule3MinUtteranceLength) {
  const std::string id = CopyJstring(env, instanceId);
  sherpaonnx::OnlineSttModelPaths paths;
  sherpaonnx::FillOnlineSttModelPathsFromStringMap(
      HashMapToStringMap(env, pathsMap), paths);

  sherpaonnx::OnlineSttInitResult result;
  {
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    g_online_stt.erase(id);
    auto inst = std::make_shared<sherpaonnx::OnlineSttWrapper>();
    result = inst->initializeCustom(
        CopyJstring(env, modelType), paths, enableEndpoint == JNI_TRUE,
        CopyJstring(env, decodingMethod), maxActivePaths,
        CopyJstring(env, hotwordsFile), hotwordsScore, numThreads,
        CopyJstring(env, provider), CopyJstring(env, ruleFsts),
        CopyJstring(env, ruleFars), dither, blankPenalty, debug == JNI_TRUE,
        rule1MustContainNonSilence == JNI_TRUE, rule1MinTrailingSilence,
        rule1MinUtteranceLength, rule2MustContainNonSilence == JNI_TRUE,
        rule2MinTrailingSilence, rule2MinUtteranceLength,
        rule3MustContainNonSilence == JNI_TRUE, rule3MinTrailingSilence,
        rule3MinUtteranceLength);
    if (result.success) {
      g_online_stt[id] = std::move(inst);
      LOGI("nativeInitializeCustom ok id=%s", id.c_str());
    } else {
      LOGE("nativeInitializeCustom failed id=%s: %s", id.c_str(),
           result.error.c_str());
    }
  }
  return InitResultMap(env, result);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeCreateStream(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId,
    jstring hotwords) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return JNI_FALSE;
  return inst->createStream(CopyJstring(env, streamId),
                            CopyJstring(env, hotwords))
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeAcceptWaveform(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId,
    jint sampleRate, jfloatArray samples) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return;
  const auto pcm = CopyFloatArray(env, samples);
  if (!pcm.empty()) {
    inst->acceptWaveform(CopyJstring(env, streamId), sampleRate, pcm.data(),
                         pcm.size());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeInputFinished(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (inst) inst->inputFinished(CopyJstring(env, streamId));
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeIsReady(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return JNI_FALSE;
  return inst->isReady(CopyJstring(env, streamId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeDecode(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (inst) inst->decode(CopyJstring(env, streamId));
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeGetResult(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  sherpaonnx::OnlineSttStreamResult result;
  if (inst) {
    result = inst->getResult(CopyJstring(env, streamId));
  }

  sherpaonnx::PutString(env, map, mapPut, "text", result.text);

  jmethodID listAdd = nullptr;
  jobject tokens = NewArrayList(env, &listAdd);
  if (tokens && listAdd) {
    for (const auto& t : result.tokens) {
      jstring js = env->NewStringUTF(t.c_str());
      env->CallBooleanMethod(tokens, listAdd, js);
      env->DeleteLocalRef(js);
    }
    jstring key = env->NewStringUTF("tokens");
    env->CallObjectMethod(map, mapPut, key, tokens);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(tokens);
  }

  jfloatArray ts =
      env->NewFloatArray(static_cast<jsize>(result.timestamps.size()));
  if (ts) {
    if (!result.timestamps.empty()) {
      env->SetFloatArrayRegion(ts, 0,
                               static_cast<jsize>(result.timestamps.size()),
                               result.timestamps.data());
    }
    jstring key = env->NewStringUTF("timestamps");
    env->CallObjectMethod(map, mapPut, key, ts);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(ts);
  }

  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeIsEndpoint(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return JNI_FALSE;
  return inst->isEndpoint(CopyJstring(env, streamId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeResetStream(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (inst) inst->resetStream(CopyJstring(env, streamId));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeReleaseStream(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (inst) inst->releaseStream(CopyJstring(env, streamId));
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeGetSampleRate(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return 16000;
  return inst->getSampleRate();
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  std::lock_guard<std::mutex> lock(g_online_stt_mutex);
  return g_online_stt.count(CopyJstring(env, instanceId)) > 0 ? JNI_TRUE
                                                              : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeUnload(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::OnlineSttWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    auto it = g_online_stt.find(id);
    if (it != g_online_stt.end()) {
      removed = std::move(it->second);
      g_online_stt.erase(it);
    }
  }
  if (removed) {
    removed->unload();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxOnlineSttHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string, std::shared_ptr<sherpaonnx::OnlineSttWrapper>>
      local;
  {
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    local.swap(g_online_stt);
  }
  for (auto& entry : local) {
    if (entry.second) entry.second->unload();
  }
  LOGI("nativeShutdownAll cleared=%zu", local.size());
}

}  // extern "C"
