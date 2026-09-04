#include "pyannote-segmentation-session.h"

#include <android/log.h>
#include <jni.h>

#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define PYANNOTE_SEG_JNI_TAG "SherpaOnnxPyannoteSegJNI"
#define LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, PYANNOTE_SEG_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_mutex;
std::unordered_map<
    std::string,
    std::shared_ptr<sherpaonnx::diarization::PyannoteSegmentationSession>>
    g_instances;

std::shared_ptr<sherpaonnx::diarization::PyannoteSegmentationSession>
LookupSession(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_instances.find(id);
  if (it == g_instances.end() || !it->second) {
    return nullptr;
  }
  return it->second;
}

std::string CopyJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return {};
  }
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    return {};
  }
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) {
    return nullptr;
  }
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
  if (!map) {
    return nullptr;
  }
  *outPut = mapPut;
  return map;
}

bool PutBool(JNIEnv* env, jobject map, jmethodID putId, const char* key,
             jboolean value) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  if (!boolClass) {
    return false;
  }
  jmethodID valueOf =
      env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  if (!valueOf) {
    env->DeleteLocalRef(boolClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, value);
  env->DeleteLocalRef(boolClass);
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

bool PutString(JNIEnv* env, jobject map, jmethodID putId, const char* key,
               const std::string& value) {
  jstring jkey = env->NewStringUTF(key);
  jstring jval = env->NewStringUTF(value.c_str());
  if (!jkey || !jval) {
    if (jkey) env->DeleteLocalRef(jkey);
    if (jval) env->DeleteLocalRef(jval);
    return false;
  }
  env->CallObjectMethod(map, putId, jkey, jval);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(jval);
  return true;
}

bool PutFloat(JNIEnv* env, jobject map, jmethodID putId, const char* key,
              jfloat value) {
  jclass floatClass = env->FindClass("java/lang/Float");
  if (!floatClass) {
    return false;
  }
  jmethodID valueOf =
      env->GetStaticMethodID(floatClass, "valueOf", "(F)Ljava/lang/Float;");
  if (!valueOf) {
    env->DeleteLocalRef(floatClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(floatClass, valueOf, value);
  env->DeleteLocalRef(floatClass);
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

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_segment_core_PyannoteSegmentationRuntime_nativeCreate(
    JNIEnv* env, jclass /*clazz*/, jstring jInstanceId, jstring jModelPath,
    jfloat windowShiftRatio, jfloat minDurationOn, jfloat minDurationOff,
    jint numThreads) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) {
    return nullptr;
  }

  const std::string instanceId = CopyJstring(env, jInstanceId);
  const std::string modelPath = CopyJstring(env, jModelPath);
  if (instanceId.empty() || modelPath.empty()) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error", "instanceId and modelPath are required");
    return map;
  }

  auto session =
      std::make_shared<sherpaonnx::diarization::PyannoteSegmentationSession>();
  sherpaonnx::diarization::PyannoteSegOptions options;
  options.model_path = modelPath;
  options.window_shift_ratio =
      windowShiftRatio > 0.f ? windowShiftRatio : 0.1f;
  options.min_duration_on = minDurationOn;
  options.min_duration_off = minDurationOff;
  options.num_threads = numThreads > 0 ? numThreads : 1;

  auto st = session->Initialize(options);
  if (!st.ok) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error",
              st.message.empty()
                  ? (st.code.empty() ? std::string("error") : st.code)
                  : st.message);
    return map;
  }

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_instances[instanceId] = session;
  }

  PutBool(env, map, mapPut, "ok", JNI_TRUE);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_segment_core_PyannoteSegmentationRuntime_nativeProcess(
    JNIEnv* env, jclass /*clazz*/, jstring jInstanceId, jfloatArray jSamples,
    jint sampleRate) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) {
    return nullptr;
  }

  const std::string instanceId = CopyJstring(env, jInstanceId);
  auto session = LookupSession(instanceId);
  if (!session) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error", "session not found");
    return map;
  }

  if (jSamples == nullptr) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error", "samples required");
    return map;
  }

  const jsize n = env->GetArrayLength(jSamples);
  jfloat* samples = env->GetFloatArrayElements(jSamples, nullptr);
  if (samples == nullptr) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error", "failed to read samples");
    return map;
  }

  std::vector<sherpaonnx::diarization::PyannoteSpeechSpan> spans;
  auto st = session->ProcessMono(samples, static_cast<int32_t>(n), sampleRate,
                                 &spans);
  env->ReleaseFloatArrayElements(jSamples, samples, JNI_ABORT);

  if (!st.ok) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error",
              st.message.empty()
                  ? (st.code.empty() ? std::string("error") : st.code)
                  : st.message);
    return map;
  }

  jclass listClass = env->FindClass("java/util/ArrayList");
  jmethodID listInit = listClass
                           ? env->GetMethodID(listClass, "<init>", "()V")
                           : nullptr;
  jmethodID listAdd =
      listClass
          ? env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z")
          : nullptr;
  if (!listClass || !listInit || !listAdd) {
    if (listClass) env->DeleteLocalRef(listClass);
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error", "failed to allocate span list");
    return map;
  }

  jobject list = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  if (!list) {
    PutBool(env, map, mapPut, "ok", JNI_FALSE);
    PutString(env, map, mapPut, "error", "failed to allocate span list");
    return map;
  }

  for (const auto& span : spans) {
    jmethodID spanPut = nullptr;
    jobject spanMap = NewHashMap(env, &spanPut);
    if (!spanMap) {
      continue;
    }
    PutFloat(env, spanMap, spanPut, "start", span.start);
    PutFloat(env, spanMap, spanPut, "end", span.end);
    env->CallBooleanMethod(list, listAdd, spanMap);
    env->DeleteLocalRef(spanMap);
  }

  PutBool(env, map, mapPut, "ok", JNI_TRUE);
  jstring spansKey = env->NewStringUTF("spans");
  if (spansKey) {
    env->CallObjectMethod(map, mapPut, spansKey, list);
    env->DeleteLocalRef(spansKey);
  }
  env->DeleteLocalRef(list);
  return map;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_segment_core_PyannoteSegmentationRuntime_nativeRelease(
    JNIEnv* env, jclass /*clazz*/, jstring jInstanceId) {
  const std::string instanceId = CopyJstring(env, jInstanceId);
  if (instanceId.empty()) {
    return;
  }
  std::shared_ptr<sherpaonnx::diarization::PyannoteSegmentationSession>
      doomed;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_instances.find(instanceId);
    if (it != g_instances.end()) {
      doomed = std::move(it->second);
      g_instances.erase(it);
    }
  }
  if (doomed) {
    doomed->Release();
  }
}

}  // extern "C"
