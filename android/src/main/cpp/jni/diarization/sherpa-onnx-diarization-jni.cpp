#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-diarization-wrapper.h"

#include <android/log.h>
#include <jni.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#define DIARIZATION_JNI_TAG "SherpaOnnxDiarizationJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, DIARIZATION_JNI_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, DIARIZATION_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, DIARIZATION_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_diarization_mutex;
std::unordered_map<std::string, std::unique_ptr<sherpaonnx::DiarizationWrapper>>
    g_diarization_instances;

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

bool PutInt(JNIEnv* env, jobject map, jmethodID putId, const char* key, jint value) {
  jclass intClass = env->FindClass("java/lang/Integer");
  if (!intClass) return false;
  jmethodID valueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
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

bool PutFloat(JNIEnv* env, jobject map, jmethodID putId, const char* key, jfloat value) {
  jclass floatClass = env->FindClass("java/lang/Float");
  if (!floatClass) return false;
  jmethodID valueOf = env->GetStaticMethodID(floatClass, "valueOf", "(F)Ljava/lang/Float;");
  if (!valueOf) {
    env->DeleteLocalRef(floatClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(floatClass, valueOf, value);
  env->DeleteLocalRef(floatClass);
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
  jmethodID mapPut =
      env->GetMethodID(mapClass, "put",
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

jobject DiarizationInitializeResultToJava(
    JNIEnv* env,
    const sherpaonnx::DiarizationInitializeResult& result
) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "errorCode", result.errorCode);
  if (result.sampleRate > 0) {
    PutInt(env, map, mapPut, "sampleRate", result.sampleRate);
  }
  if (result.embeddingDim > 0) {
    PutInt(env, map, mapPut, "embeddingDim", result.embeddingDim);
  }
  return map;
}

jobject DiarizationProcessResultToJava(
    JNIEnv* env,
    const sherpaonnx::DiarizationProcessResult& result
) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "errorCode", result.errorCode);
  PutInt(env, map, mapPut, "numSpeakers", result.numSpeakers);
  if (result.sampleRate > 0) {
    PutInt(env, map, mapPut, "sampleRate", result.sampleRate);
  }

  jclass listClass = env->FindClass("java/util/ArrayList");
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!listClass || !mapClass) {
    if (listClass) env->DeleteLocalRef(listClass);
    if (mapClass) env->DeleteLocalRef(mapClass);
    return map;
  }
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID segPut =
      env->GetMethodID(mapClass, "put",
                       "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!listInit || !listAdd || !mapInit || !segPut) {
    env->DeleteLocalRef(listClass);
    env->DeleteLocalRef(mapClass);
    return map;
  }

  jobject segments = env->NewObject(listClass, listInit);
  if (segments) {
    for (const auto& seg : result.segments) {
      jobject segMap = env->NewObject(mapClass, mapInit);
      if (!segMap) continue;
      PutFloat(env, segMap, segPut, "start", seg.start);
      PutFloat(env, segMap, segPut, "end", seg.end);
      PutInt(env, segMap, segPut, "speaker", seg.speaker);
      env->CallBooleanMethod(segments, listAdd, segMap);
      env->DeleteLocalRef(segMap);
    }
    jstring keySegments = env->NewStringUTF("segments");
    env->CallObjectMethod(map, mapPut, keySegments, segments);
    env->DeleteLocalRef(keySegments);
    env->DeleteLocalRef(segments);
  }

  if (!result.speakersPerFrame.empty()) {
    jobject spf = env->NewObject(listClass, listInit);
    if (spf) {
      jclass intClass = env->FindClass("java/lang/Integer");
      jmethodID intValueOf =
          intClass ? env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;")
                   : nullptr;
      if (intClass && intValueOf) {
        for (int32_t v : result.speakersPerFrame) {
          jobject boxed = env->CallStaticObjectMethod(intClass, intValueOf, static_cast<jint>(v));
          if (boxed) {
            env->CallBooleanMethod(spf, listAdd, boxed);
            env->DeleteLocalRef(boxed);
          }
        }
        env->DeleteLocalRef(intClass);
      }
      jstring keySpf = env->NewStringUTF("speakersPerFrame");
      env->CallObjectMethod(map, mapPut, keySpf, spf);
      env->DeleteLocalRef(keySpf);
      env->DeleteLocalRef(spf);
    }
  }

  env->DeleteLocalRef(listClass);
  env->DeleteLocalRef(mapClass);
  return map;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeInitializeDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jstring segmentationModelPath,
    jstring embeddingModelPath,
    jfloat windowShiftRatio,
    jint numClusters,
    jfloat threshold,
    jfloat minDurationOn,
    jfloat minDurationOff,
    jint numThreads,
    jstring provider,
    jboolean debug
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  const std::string segmentationPath = CopyRequiredJstring(env, segmentationModelPath);
  const std::string embeddingPath = CopyRequiredJstring(env, embeddingModelPath);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  LOGI(
      "nativeInitializeDiarization: instanceId=%s threads=%d numClusters=%d",
      instanceIdStr.c_str(),
      numThreads,
      numClusters
  );

  sherpaonnx::DiarizationInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_diarization_mutex);
    auto& inst = g_diarization_instances[instanceIdStr];
    if (inst == nullptr) {
      inst = std::make_unique<sherpaonnx::DiarizationWrapper>();
    } else {
      inst->release();
    }
    result = inst->initialize(
        segmentationPath,
        embeddingPath,
        windowShiftRatio,
        numClusters,
        threshold,
        minDurationOn,
        minDurationOff,
        numThreads > 0 ? numThreads : 1,
        providerOpt,
        debug == JNI_TRUE
    );
    if (!result.success) {
      LOGE(
          "nativeInitializeDiarization failed: instanceId=%s error=%s code=%s",
          instanceIdStr.c_str(),
          result.error.c_str(),
          result.errorCode.c_str()
      );
      g_diarization_instances.erase(instanceIdStr);
    } else {
      LOGI(
          "nativeInitializeDiarization ok: instanceId=%s sampleRate=%d",
          instanceIdStr.c_str(),
          result.sampleRate
      );
    }
  }
  return DiarizationInitializeResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeProcessDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jfloatArray samples,
    jint sampleRate,
    jboolean includeOverlap
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);

  jsize n = samples != nullptr ? env->GetArrayLength(samples) : 0;
  if (n <= 0 || sampleRate <= 0) {
    LOGE(
        "nativeProcessDiarization: invalid input instanceId=%s n=%d sampleRate=%d",
        instanceIdStr.c_str(),
        static_cast<int>(n),
        sampleRate
    );
    sherpaonnx::DiarizationProcessResult bad;
    bad.success = false;
    bad.errorCode = "DIARIZATION_INVALID_ARGUMENT";
    bad.error = "Invalid samples or sampleRate";
    return DiarizationProcessResultToJava(env, bad);
  }

  LOGI(
      "nativeProcessDiarization: instanceId=%s n=%d sampleRate=%d includeOverlap=%d",
      instanceIdStr.c_str(),
      static_cast<int>(n),
      sampleRate,
      includeOverlap == JNI_TRUE ? 1 : 0
  );

  std::vector<float> input(static_cast<size_t>(n));
  env->GetFloatArrayRegion(samples, 0, n, input.data());

  // Unlock during process so nativeCancelDiarization can interrupt.
  sherpaonnx::DiarizationWrapper* wrapper = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_diarization_mutex);
    auto it = g_diarization_instances.find(instanceIdStr);
    if (it == g_diarization_instances.end() || it->second == nullptr) {
      LOGE("nativeProcessDiarization: instance not found: %s", instanceIdStr.c_str());
      sherpaonnx::DiarizationProcessResult missing;
      missing.success = false;
      missing.errorCode = "DIARIZATION_NOT_INITIALIZED";
      missing.error = "Diarization instance not found: " + instanceIdStr;
      return DiarizationProcessResultToJava(env, missing);
    }
    wrapper = it->second.get();
  }

  sherpaonnx::DiarizationProcessResult result =
      wrapper->processMonoSamples(input, sampleRate, includeOverlap == JNI_TRUE, {});
  if (!result.success) {
    LOGE(
        "nativeProcessDiarization failed: %s code=%s",
        result.error.c_str(),
        result.errorCode.c_str()
    );
  } else {
    LOGI(
        "nativeProcessDiarization ok: instanceId=%s segments=%zu speakers=%d",
        instanceIdStr.c_str(),
        result.segments.size(),
        result.numSpeakers
    );
  }
  return DiarizationProcessResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeReclusterDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jint numClusters,
    jfloat threshold
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  LOGI(
      "nativeReclusterDiarization: instanceId=%s numClusters=%d threshold=%f",
      instanceIdStr.c_str(),
      numClusters,
      threshold
  );

  sherpaonnx::DiarizationProcessResult result;
  {
    std::lock_guard<std::mutex> lock(g_diarization_mutex);
    auto it = g_diarization_instances.find(instanceIdStr);
    if (it == g_diarization_instances.end() || it->second == nullptr) {
      result.success = false;
      result.errorCode = "DIARIZATION_NOT_INITIALIZED";
      result.error = "Diarization instance not found: " + instanceIdStr;
      return DiarizationProcessResultToJava(env, result);
    }
    result = it->second->recluster(numClusters, threshold);
  }
  return DiarizationProcessResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeGetClusterEmbeddings(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);

  std::vector<sherpaonnx::DiarizationClusterEmbeddingDto> embeddings;
  {
    std::lock_guard<std::mutex> lock(g_diarization_mutex);
    auto it = g_diarization_instances.find(instanceIdStr);
    if (it == g_diarization_instances.end() || it->second == nullptr) {
      LOGW("nativeGetClusterEmbeddings: instance not found: %s", instanceIdStr.c_str());
      embeddings.clear();
    } else {
      embeddings = it->second->getClusterEmbeddings();
    }
  }

  jclass listClass = env->FindClass("java/util/ArrayList");
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!listClass || !mapClass) {
    if (listClass) env->DeleteLocalRef(listClass);
    if (mapClass) env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut =
      env->GetMethodID(mapClass, "put",
                       "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!listInit || !listAdd || !mapInit || !mapPut) {
    env->DeleteLocalRef(listClass);
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }

  jobject list = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  if (!list) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }

  for (const auto& entry : embeddings) {
    jobject map = env->NewObject(mapClass, mapInit);
    if (!map) continue;
    PutInt(env, map, mapPut, "speaker", entry.speaker);
    jfloatArray embArray =
        env->NewFloatArray(static_cast<jsize>(entry.embedding.size()));
    if (embArray) {
      if (!entry.embedding.empty()) {
        env->SetFloatArrayRegion(
            embArray,
            0,
            static_cast<jsize>(entry.embedding.size()),
            entry.embedding.data()
        );
      }
      jstring keyEmb = env->NewStringUTF("embedding");
      env->CallObjectMethod(map, mapPut, keyEmb, embArray);
      env->DeleteLocalRef(keyEmb);
      env->DeleteLocalRef(embArray);
    }
    env->CallBooleanMethod(list, listAdd, map);
    env->DeleteLocalRef(map);
  }
  env->DeleteLocalRef(mapClass);
  return list;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeCancelDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  LOGI("nativeCancelDiarization: instanceId=%s", instanceIdStr.c_str());
  std::lock_guard<std::mutex> lock(g_diarization_mutex);
  auto it = g_diarization_instances.find(instanceIdStr);
  if (it != g_diarization_instances.end() && it->second != nullptr) {
    it->second->cancel();
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeUnloadDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  LOGI("nativeUnloadDiarization: instanceId=%s", instanceIdStr.c_str());
  std::lock_guard<std::mutex> lock(g_diarization_mutex);
  auto it = g_diarization_instances.find(instanceIdStr);
  if (it != g_diarization_instances.end()) {
    if (it->second != nullptr) {
      it->second->cancel();
      it->second->release();
    }
    g_diarization_instances.erase(it);
  }
}

}  // extern "C"
