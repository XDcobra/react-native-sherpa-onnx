#include "sherpa-onnx-stt-engine-wrapper.h"
#include "jni/jni_utf8.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-path-fill.h"
#include "jni/offline_pcm_view.h"

#include <android/log.h>
#include <jni.h>

#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#define STT_JNI_TAG "SherpaOnnx:stt"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, STT_JNI_TAG, __VA_ARGS__)
#define LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, STT_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_stt_mutex;
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::SttWrapper>> g_stt;

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

std::shared_ptr<sherpaonnx::SttWrapper> Lookup(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_stt_mutex);
  auto it = g_stt.find(id);
  if (it == g_stt.end()) return nullptr;
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

void FillWhisperOpts(JNIEnv* env, jobject map,
                     sherpaonnx::SttWhisperOptions* out) {
  if (!map || !out) return;
  auto m = HashMapToStringMap(env, map);
  if (m.count("language")) out->language = m["language"];
  if (m.count("task")) out->task = m["task"];
  if (m.count("tailPaddings")) out->tail_paddings = std::stoi(m["tailPaddings"]);
  if (m.count("enableTokenTimestamps"))
    out->enable_token_timestamps = m["enableTokenTimestamps"] == "true";
  if (m.count("enableSegmentTimestamps"))
    out->enable_segment_timestamps = m["enableSegmentTimestamps"] == "true";
}

void FillSenseVoiceOpts(JNIEnv* env, jobject map,
                        sherpaonnx::SttSenseVoiceOptions* out) {
  if (!map || !out) return;
  auto m = HashMapToStringMap(env, map);
  if (m.count("language")) out->language = m["language"];
  if (m.count("useItn")) out->use_itn = m["useItn"] == "true";
}

void FillCanaryOpts(JNIEnv* env, jobject map,
                    sherpaonnx::SttCanaryOptions* out) {
  if (!map || !out) return;
  auto m = HashMapToStringMap(env, map);
  if (m.count("srcLang")) out->src_lang = m["srcLang"];
  if (m.count("tgtLang")) out->tgt_lang = m["tgtLang"];
  if (m.count("usePnc")) out->use_pnc = m["usePnc"] == "true";
}

void FillFunasrOpts(JNIEnv* env, jobject map,
                    sherpaonnx::SttFunAsrNanoOptions* out) {
  if (!map || !out) return;
  auto m = HashMapToStringMap(env, map);
  if (m.count("systemPrompt")) out->system_prompt = m["systemPrompt"];
  if (m.count("userPrompt")) out->user_prompt = m["userPrompt"];
  if (m.count("maxNewTokens")) out->max_new_tokens = std::stoi(m["maxNewTokens"]);
  if (m.count("temperature")) out->temperature = std::stof(m["temperature"]);
  if (m.count("topP")) out->top_p = std::stof(m["topP"]);
  if (m.count("seed")) out->seed = std::stoi(m["seed"]);
  if (m.count("language")) out->language = m["language"];
  if (m.count("itn")) out->itn = m["itn"] == "true";
  if (m.count("hotwords")) out->hotwords = m["hotwords"];
}

void FillQwen3Opts(JNIEnv* env, jobject map,
                   sherpaonnx::SttQwen3AsrOptions* out) {
  if (!map || !out) return;
  auto m = HashMapToStringMap(env, map);
  if (m.count("maxTotalLen")) out->max_total_len = std::stoi(m["maxTotalLen"]);
  if (m.count("maxNewTokens")) out->max_new_tokens = std::stoi(m["maxNewTokens"]);
  if (m.count("temperature")) out->temperature = std::stof(m["temperature"]);
  if (m.count("topP")) out->top_p = std::stof(m["topP"]);
  if (m.count("seed")) out->seed = std::stoi(m["seed"]);
  if (m.count("hotwords")) out->hotwords = m["hotwords"];
}

void FillCohereOpts(JNIEnv* env, jobject map,
                    sherpaonnx::SttCohereTranscribeOptions* out) {
  if (!map || !out) return;
  auto m = HashMapToStringMap(env, map);
  if (m.count("language")) out->language = m["language"];
  if (m.count("usePunct")) out->use_punct = m["usePunct"] == "true";
  if (m.count("useItn")) out->use_itn = m["useItn"] == "true";
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeInitializeCustom(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring modelType,
    jobject pathsMap, jboolean debug, jstring hotwordsFile, jfloat hotwordsScore,
    jint numThreads, jstring provider, jstring ruleFsts, jstring ruleFars,
    jfloat dither, jobject whisperMap, jobject senseVoiceMap,
    jobject canaryMap, jobject funasrMap, jobject qwen3Map,
    jobject cohereMap) {
  const std::string id = CopyJstring(env, instanceId);
  const std::string type = CopyJstring(env, modelType);
  auto pathStrings = HashMapToStringMap(env, pathsMap);
  sherpaonnx::SttModelPaths paths;
  sherpaonnx::FillSttModelPathsFromStringMap(pathStrings, paths);

  sherpaonnx::SttWhisperOptions whisper;
  sherpaonnx::SttSenseVoiceOptions senseVoice;
  sherpaonnx::SttCanaryOptions canary;
  sherpaonnx::SttFunAsrNanoOptions funasr;
  sherpaonnx::SttQwen3AsrOptions qwen3;
  sherpaonnx::SttCohereTranscribeOptions cohere;
  FillWhisperOpts(env, whisperMap, &whisper);
  FillSenseVoiceOpts(env, senseVoiceMap, &senseVoice);
  FillCanaryOpts(env, canaryMap, &canary);
  FillFunasrOpts(env, funasrMap, &funasr);
  FillQwen3Opts(env, qwen3Map, &qwen3);
  FillCohereOpts(env, cohereMap, &cohere);

  std::optional<std::string> hw = OptJstring(env, hotwordsFile);
  std::optional<float> hwScore =
      hotwordsScore >= 0.f ? std::optional<float>(hotwordsScore) : std::nullopt;
  std::optional<int32_t> threads =
      numThreads > 0 ? std::optional<int32_t>(numThreads) : std::nullopt;
  auto prov = OptJstring(env, provider);
  auto rfst = OptJstring(env, ruleFsts);
  auto rfar = OptJstring(env, ruleFars);
  std::optional<float> dith =
      dither >= 0.f ? std::optional<float>(dither) : std::nullopt;

  sherpaonnx::SttInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    g_stt.erase(id);
    auto inst = std::make_shared<sherpaonnx::SttWrapper>();
    result = inst->initializeCustom(
        type, paths, debug == JNI_TRUE, hw, hwScore, threads, prov, rfst, rfar,
        dith, whisperMap ? &whisper : nullptr,
        senseVoiceMap ? &senseVoice : nullptr, canaryMap ? &canary : nullptr,
        funasrMap ? &funasr : nullptr, qwen3Map ? &qwen3 : nullptr,
        cohereMap ? &cohere : nullptr);
    if (result.success) {
      g_stt[id] = std::move(inst);
      LOGI("nativeInitializeCustom ok id=%s type=%s", id.c_str(), type.c_str());
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
  sherpaonnx::PutString(env, map, mapPut, "modelType",
                        result.modelType.empty() ? type : result.modelType);
  sherpaonnx::PutString(env, map, mapPut, "decodingMethod",
                        result.decodingMethod);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeTranscribeSamples(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jfloatArray samples,
    jint sampleRate) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  if (!inst || !inst->isInitialized()) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "STT not initialized");
    return map;
  }
  try {
    const auto pcm = CopyFloatArray(env, samples);
    const auto result = inst->transcribeSamples(
        pcm.empty() ? nullptr : pcm.data(), static_cast<int32_t>(pcm.size()),
        sampleRate);
    sherpaonnx::PutBoolean(env, map, mapPut, "success", true);
    sherpaonnx::PutString(env, map, mapPut, "text", result.text);
    sherpaonnx::PutString(env, map, mapPut, "lang", result.lang);
    sherpaonnx::PutString(env, map, mapPut, "emotion", result.emotion);
    sherpaonnx::PutString(env, map, mapPut, "event", result.event);

    jmethodID listAdd = nullptr;
    jobject tokens = NewArrayList(env, &listAdd);
    if (tokens && listAdd) {
      for (const auto& t : result.tokens) {
        jstring js = sherpaonnx::NewJStringUtf8(env, t);
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
    jfloatArray dur =
        env->NewFloatArray(static_cast<jsize>(result.durations.size()));
    if (dur) {
      if (!result.durations.empty()) {
        env->SetFloatArrayRegion(dur, 0,
                                 static_cast<jsize>(result.durations.size()),
                                 result.durations.data());
      }
      jstring key = env->NewStringUTF("durations");
      env->CallObjectMethod(map, mapPut, key, dur);
      env->DeleteLocalRef(key);
      env->DeleteLocalRef(dur);
    }
  } catch (const std::exception& e) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", e.what());
  } catch (...) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "Recognition failed");
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeTranscribeFromBuffer(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring bufferId,
    jint startSample, jint endSampleExclusive) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  if (!inst || !inst->isInitialized()) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "STT not initialized");
    return map;
  }
  PaOfflineSampleView view;
  std::string errCode;
  std::string errMsg;
  if (!JniAcquireOfflinePcm(env, bufferId, startSample, endSampleExclusive, &view,
                            &errCode, &errMsg)) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", errMsg.empty() ? errCode : errMsg);
    return map;
  }
  try {
    const auto result = inst->transcribeSamples(
        view.count > 0 ? view.data : nullptr, static_cast<int32_t>(view.count),
        view.sampleRate);
    sherpaonnx::PutBoolean(env, map, mapPut, "success", true);
    sherpaonnx::PutString(env, map, mapPut, "text", result.text);
    sherpaonnx::PutString(env, map, mapPut, "lang", result.lang);
    sherpaonnx::PutString(env, map, mapPut, "emotion", result.emotion);
    sherpaonnx::PutString(env, map, mapPut, "event", result.event);

    jmethodID listAdd = nullptr;
    jobject tokens = NewArrayList(env, &listAdd);
    if (tokens && listAdd) {
      for (const auto& t : result.tokens) {
        jstring js = sherpaonnx::NewJStringUtf8(env, t);
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
    jfloatArray dur =
        env->NewFloatArray(static_cast<jsize>(result.durations.size()));
    if (dur) {
      if (!result.durations.empty()) {
        env->SetFloatArrayRegion(dur, 0,
                                 static_cast<jsize>(result.durations.size()),
                                 result.durations.data());
      }
      jstring key = env->NewStringUTF("durations");
      env->CallObjectMethod(map, mapPut, key, dur);
      env->DeleteLocalRef(key);
      env->DeleteLocalRef(dur);
    }
  } catch (const std::exception& e) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", e.what());
  } catch (...) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "Recognition failed");
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeSetConfig(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring decodingMethod,
    jint maxActivePaths, jstring hotwordsFile, jfloat hotwordsScore,
    jfloat blankPenalty, jstring ruleFsts, jstring ruleFars) {
  auto inst = Lookup(CopyJstring(env, instanceId));
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  if (!inst || !inst->isInitialized()) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", "STT not initialized");
    return map;
  }
  try {
    sherpaonnx::SttRuntimeConfigOptions opts;
    if (auto s = OptJstring(env, decodingMethod)) opts.decoding_method = s;
    if (maxActivePaths > 0) opts.max_active_paths = maxActivePaths;
    if (auto s = OptJstring(env, hotwordsFile)) opts.hotwords_file = s;
    if (hotwordsScore >= 0.f) opts.hotwords_score = hotwordsScore;
    if (blankPenalty >= 0.f) opts.blank_penalty = blankPenalty;
    if (auto s = OptJstring(env, ruleFsts)) opts.rule_fsts = s;
    if (auto s = OptJstring(env, ruleFars)) opts.rule_fars = s;
    inst->setConfig(opts);
    sherpaonnx::PutBoolean(env, map, mapPut, "success", true);
  } catch (const std::exception& e) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error", e.what());
  }
  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeHasInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  std::lock_guard<std::mutex> lock(g_stt_mutex);
  return g_stt.count(CopyJstring(env, instanceId)) > 0 ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeUnload(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::SttWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt.find(id);
    if (it != g_stt.end()) {
      removed = std::move(it->second);
      g_stt.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnload id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_stt_facade_SherpaOnnxSttHelper_nativeShutdownAll(
    JNIEnv* /* env */, jclass /* clazz */) {
  decltype(g_stt) local;
  {
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    local.swap(g_stt);
  }
  for (auto& e : local) {
    if (e.second) e.second->release();
  }
}

}  // extern "C"
