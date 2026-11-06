#include "sherpa-onnx-tts-engine-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-path-fill.h"
#include "jni/offline_pcm_view.h"
#include "TextRegistry.h"

#include <android/log.h>
#include <jni.h>

#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#define TTS_JNI_TAG "SherpaOnnx:tts"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TTS_JNI_TAG, __VA_ARGS__)
#define LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, TTS_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_tts_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::TtsWrapper>> g_tts;

std::string CopyJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

std::optional<std::string> OptJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return std::nullopt;
  auto s = CopyJstring(env, value);
  if (s.empty()) return std::nullopt;
  return s;
}

std::optional<float> OptFloat(jfloat value) {
  if (std::isnan(value)) return std::nullopt;
  return value;
}

std::optional<int32_t> OptInt(jint value) {
  if (value < 0) return std::nullopt;
  return value;
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

std::shared_ptr<sherpaonnx::TtsWrapper> Lookup(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_tts_mutex);
  auto it = g_tts.find(id);
  if (it == g_tts.end()) return nullptr;
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

jobject AudioResultToMap(JNIEnv* env,
                         const sherpaonnx::TtsWrapper::AudioResult& audio) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  const bool ok = !audio.samples.empty() && audio.sampleRate > 0;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", ok);
  if (!ok) {
    sherpaonnx::PutString(env, map, mapPut, "error", "TTS generated empty audio");
    return map;
  }
  jfloatArray samples =
      env->NewFloatArray(static_cast<jsize>(audio.samples.size()));
  if (samples) {
    env->SetFloatArrayRegion(samples, 0,
                             static_cast<jsize>(audio.samples.size()),
                             audio.samples.data());
    jstring key = env->NewStringUTF("samples");
    env->CallObjectMethod(map, mapPut, key, samples);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(samples);
  }
  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID valueOf =
      env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  jobject boxed = env->CallStaticObjectMethod(intClass, valueOf, audio.sampleRate);
  jstring rateKey = env->NewStringUTF("sampleRate");
  env->CallObjectMethod(map, mapPut, rateKey, boxed);
  env->DeleteLocalRef(rateKey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(intClass);
  return map;
}

std::vector<std::vector<int32_t>> ParsePhonemes(JNIEnv* env,
                                                jobjectArray outer) {
  std::vector<std::vector<int32_t>> out;
  if (outer == nullptr) return out;
  const jsize n = env->GetArrayLength(outer);
  out.reserve(static_cast<size_t>(n));
  for (jsize i = 0; i < n; ++i) {
    auto inner = static_cast<jintArray>(env->GetObjectArrayElement(outer, i));
    std::vector<int32_t> row;
    if (inner != nullptr) {
      const jsize m = env->GetArrayLength(inner);
      row.resize(static_cast<size_t>(m));
      if (m > 0) {
        env->GetIntArrayRegion(inner, 0, m, row.data());
      }
      env->DeleteLocalRef(inner);
    }
    out.push_back(std::move(row));
  }
  return out;
}

std::vector<std::vector<std::string>> ParseTokens(JNIEnv* env,
                                                  jobjectArray outer) {
  std::vector<std::vector<std::string>> out;
  if (outer == nullptr) return out;
  const jsize n = env->GetArrayLength(outer);
  out.reserve(static_cast<size_t>(n));
  for (jsize i = 0; i < n; ++i) {
    auto inner = static_cast<jobjectArray>(env->GetObjectArrayElement(outer, i));
    std::vector<std::string> row;
    if (inner != nullptr) {
      const jsize m = env->GetArrayLength(inner);
      row.reserve(static_cast<size_t>(m));
      for (jsize j = 0; j < m; ++j) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(inner, j));
        row.push_back(CopyJstring(env, js));
        if (js) env->DeleteLocalRef(js);
      }
      env->DeleteLocalRef(inner);
    }
    out.push_back(std::move(row));
  }
  return out;
}

std::string ResolveTtsText(JNIEnv* env, jstring text, jstring textBufferId,
                           std::string* error) {
  const std::string textId = CopyJstring(env, textBufferId);
  if (!textId.empty()) {
    TxtOfflineTextView view;
    std::string errCode;
    std::string errMsg;
    // Allow empty for phoneme-only generation.
    if (!txt_acquire_offline_text_view(textId, /*allowEmpty=*/true, &view,
                                       &errCode, &errMsg)) {
      if (error) *error = errMsg.empty() ? "Text buffer not found" : errMsg;
      return {};
    }
    if (view.bytes == 0 || view.data == nullptr) {
      return {};
    }
    return std::string(view.data, view.bytes);
  }
  return CopyJstring(env, text);
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeInitializeCustom(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jobject pathsMap, jint numThreads, jboolean debug, jfloat noiseScale,
    jfloat noiseScaleW, jfloat lengthScale, jstring ruleFsts, jstring ruleFars,
    jint maxNumSentences, jfloat silenceScale, jstring provider,
    jstring kokoroLang) {
  const std::string id = CopyJstring(env, instanceId);
  sherpaonnx::TtsModelPaths paths;
  sherpaonnx::FillTtsModelPathsFromStringMap(HashMapToStringMap(env, pathsMap),
                                             paths);

  sherpaonnx::TtsInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    g_tts.erase(id);
    auto inst = std::make_shared<sherpaonnx::TtsWrapper>();
    result = inst->initializeCustom(
        CopyJstring(env, modelType), paths, numThreads, debug == JNI_TRUE,
        OptFloat(noiseScale), OptFloat(noiseScaleW), OptFloat(lengthScale),
        OptJstring(env, ruleFsts), OptJstring(env, ruleFars),
        OptInt(maxNumSentences), OptFloat(silenceScale),
        OptJstring(env, provider), OptJstring(env, kokoroLang));
    if (result.success) {
      g_tts[id] = std::move(inst);
      LOGI("nativeInitializeCustom ok id=%s", id.c_str());
    } else {
      LOGE("nativeInitializeCustom failed id=%s: %s", id.c_str(),
           result.error.c_str());
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
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeGenerate(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring text, jint sid,
    jfloat speed, jstring textBufferId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst || !inst->isInitialized()) {
    jmethodID mapPut = nullptr;
    jobject map = NewHashMap(env, &mapPut);
    if (!map) return nullptr;
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "TTS not initialized");
    return map;
  }
  std::string textErr;
  const std::string resolved = ResolveTtsText(env, text, textBufferId, &textErr);
  if (!textErr.empty() && !CopyJstring(env, textBufferId).empty()) {
    jmethodID mapPut = nullptr;
    jobject map = NewHashMap(env, &mapPut);
    if (!map) return nullptr;
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", textErr);
    return map;
  }
  const auto audio = inst->generate(resolved, sid, speed);
  return AudioResultToMap(env, audio);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeGenerateWithOptions(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring text, jint sid,
    jfloat speed, jboolean applyNumSteps, jint numSteps, jfloat silenceScale,
    jfloatArray referenceAudio, jint referenceSampleRate, jstring referenceText,
    jobject extraMap, jobjectArray phonemeCodepoints, jobjectArray tokens,
    jstring referenceBufferId, jstring textBufferId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst || !inst->isInitialized()) {
    jmethodID mapPut = nullptr;
    jobject map = NewHashMap(env, &mapPut);
    if (!map) return nullptr;
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "TTS not initialized");
    return map;
  }

  sherpaonnx::VoiceCloneOptions opts;
  opts.apply_num_steps = applyNumSteps == JNI_TRUE;
  opts.num_steps = numSteps;
  opts.silence_scale = silenceScale;
  opts.reference_text = CopyJstring(env, referenceText);
  PaOfflineSampleView refView;
  const std::string refId = CopyJstring(env, referenceBufferId);
  if (!refId.empty()) {
    std::string errCode;
    std::string errMsg;
    if (!pa_acquire_offline_sample_view(refId, -1, -1, &refView, &errCode, &errMsg)) {
      jmethodID mapPut = nullptr;
      jobject map = NewHashMap(env, &mapPut);
      if (!map) return nullptr;
      sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
      sherpaonnx::PutString(env, map, mapPut, "error",
                            errMsg.empty() ? "Reference audio buffer not found" : errMsg);
      return map;
    }
    if (refView.count == 0 || refView.data == nullptr || refView.sampleRate <= 0) {
      jmethodID mapPut = nullptr;
      jobject map = NewHashMap(env, &mapPut);
      if (!map) return nullptr;
      sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
      sherpaonnx::PutString(env, map, mapPut, "error", "Reference audio is empty");
      return map;
    }
    opts.reference_pcm = refView.data;
    opts.reference_pcm_count = static_cast<int32_t>(refView.count);
    opts.reference_sample_rate = refView.sampleRate;
    opts.reference_keepalive = refView.entry;
  } else {
    opts.reference_audio = CopyFloatArray(env, referenceAudio);
    opts.reference_sample_rate = referenceSampleRate;
  }
  if (extraMap != nullptr) {
    for (const auto& kv : HashMapToStringMap(env, extraMap)) {
      opts.extra[kv.first] = kv.second;
    }
  }
  opts.phoneme_codepoints = ParsePhonemes(env, phonemeCodepoints);
  opts.tokens = ParseTokens(env, tokens);

  std::string textErr;
  const std::string resolved = ResolveTtsText(env, text, textBufferId, &textErr);
  if (!textErr.empty() && !CopyJstring(env, textBufferId).empty()) {
    jmethodID mapPut = nullptr;
    jobject map = NewHashMap(env, &mapPut);
    if (!map) return nullptr;
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", textErr);
    return map;
  }
  const auto audio = inst->generate(resolved, sid, speed, std::optional(opts));
  return AudioResultToMap(env, audio);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeGetSampleRate(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return 0;
  return inst->getSampleRate();
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeGetNumSpeakers(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  if (!inst) return 0;
  return inst->getNumSpeakers();
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  std::lock_guard<std::mutex> lock(g_tts_mutex);
  return g_tts.count(CopyJstring(env, instanceId)) > 0 ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeUnload(JNIEnv* env,
                                                         jclass /* clazz */,
                                                         jstring instanceId) {
  const std::string id = CopyJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::TtsWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts.find(id);
    if (it != g_tts.end()) {
      removed = std::move(it->second);
      g_tts.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_tts_nativeapi_TtsNative_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string, std::shared_ptr<sherpaonnx::TtsWrapper>> local;
  {
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    local.swap(g_tts);
  }
  for (auto& entry : local) {
    if (entry.second) entry.second->release();
  }
  LOGI("nativeShutdownAll cleared=%zu", local.size());
}

}  // extern "C"
