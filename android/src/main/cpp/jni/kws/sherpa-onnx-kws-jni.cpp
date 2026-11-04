#include "sherpa-onnx-kws-engine-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"

#include <android/log.h>
#include <jni.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define KWS_JNI_TAG "SherpaOnnx:kws"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, KWS_JNI_TAG, __VA_ARGS__)
#define LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, KWS_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_kws_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::KwsEngineWrapper>>
    g_kws;

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

bool PutFloat(JNIEnv* env, jobject map, jmethodID putId, const char* key,
              jfloat value) {
  jclass floatClass = env->FindClass("java/lang/Float");
  if (!floatClass) return false;
  jmethodID valueOf =
      env->GetStaticMethodID(floatClass, "valueOf", "(F)Ljava/lang/Float;");
  if (!valueOf) {
    env->DeleteLocalRef(floatClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(floatClass, valueOf, value);
  env->DeleteLocalRef(floatClass);
  if (!boxed) return false;
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, putId, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  return true;
}

std::shared_ptr<sherpaonnx::KwsEngineWrapper> Lookup(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_kws_mutex);
  auto it = g_kws.find(id);
  if (it == g_kws.end()) return nullptr;
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
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeInitialize(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring encoder,
    jstring decoder, jstring joiner, jstring tokens, jstring keywordsFile,
    jfloat keywordsScore, jfloat keywordsThreshold, jint numTrailingBlanks,
    jint maxActivePaths, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string enc = CopyRequiredJstring(env, encoder);
  const std::string dec = CopyRequiredJstring(env, decoder);
  const std::string joi = CopyRequiredJstring(env, joiner);
  const std::string tok = CopyRequiredJstring(env, tokens);
  const std::string kw = CopyRequiredJstring(env, keywordsFile);
  const std::string prov = CopyRequiredJstring(env, provider);

  sherpaonnx::KwsEngineInitResult result;
  {
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    g_kws.erase(id);
    auto inst = std::make_shared<sherpaonnx::KwsEngineWrapper>();
    result = inst->initialize(
        enc, dec, joi, tok, kw, keywordsScore, keywordsThreshold,
        numTrailingBlanks, maxActivePaths, numThreads,
        prov.empty() ? "cpu" : prov, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitialize failed id=%s: %s", id.c_str(),
           result.error.c_str());
    } else {
      g_kws[id] = std::move(inst);
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

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeCreateStream(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId,
    jstring keywords) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (!inst) return JNI_FALSE;
  const bool ok = inst->createStream(CopyRequiredJstring(env, streamId),
                                     CopyRequiredJstring(env, keywords));
  return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeAcceptWaveform(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId,
    jint sampleRate, jfloatArray samples) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (!inst) return;
  const auto pcm = CopyFloatArray(env, samples);
  if (!pcm.empty()) {
    inst->acceptWaveform(CopyRequiredJstring(env, streamId), sampleRate,
                         pcm.data(), pcm.size());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeInputFinished(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (inst) {
    inst->inputFinished(CopyRequiredJstring(env, streamId));
  }
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeIsReady(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (!inst) return JNI_FALSE;
  return inst->isReady(CopyRequiredJstring(env, streamId)) ? JNI_TRUE
                                                           : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeDecode(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (inst) {
    inst->decode(CopyRequiredJstring(env, streamId));
  }
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeGetResult(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  sherpaonnx::KwsEngineStreamResult result;
  if (inst) {
    result = inst->getResult(CopyRequiredJstring(env, streamId));
  }

  sherpaonnx::PutString(env, map, mapPut, "keyword", result.keyword);
  PutFloat(env, map, mapPut, "startTime", result.startTime);

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

  jfloatArray ts = env->NewFloatArray(static_cast<jsize>(result.timestamps.size()));
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

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeResetStream(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (inst) {
    inst->resetStream(CopyRequiredJstring(env, streamId));
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeReleaseStream(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring streamId) {
  auto inst = Lookup(CopyRequiredJstring(env, instanceId));
  if (inst) {
    inst->releaseStream(CopyRequiredJstring(env, streamId));
  }
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  std::lock_guard<std::mutex> lock(g_kws_mutex);
  return g_kws.count(CopyRequiredJstring(env, instanceId)) > 0 ? JNI_TRUE
                                                               : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeUnload(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::KwsEngineWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    auto it = g_kws.find(id);
    if (it != g_kws.end()) {
      removed = std::move(it->second);
      g_kws.erase(it);
    }
  }
  if (removed) {
    removed->unload();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_kws_facade_SherpaOnnxKwsHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string, std::shared_ptr<sherpaonnx::KwsEngineWrapper>>
      local;
  {
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    local.swap(g_kws);
  }
  for (auto& entry : local) {
    if (entry.second) entry.second->unload();
  }
  LOGI("nativeShutdownAll cleared=%zu", local.size());
}

}  // extern "C"
