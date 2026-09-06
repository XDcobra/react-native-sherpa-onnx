#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-diarization-wrapper.h"
#include "sherpa-onnx-streaming-diarization-wrapper.h"

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
std::unordered_map<std::string, std::shared_ptr<sherpaonnx::DiarizationWrapper>>
    g_diarization_instances;

std::mutex g_streaming_diarization_mutex;
std::unordered_map<std::string,
                   std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper>>
    g_streaming_diarization_instances;

std::shared_ptr<sherpaonnx::DiarizationWrapper> LookupDiarization(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_diarization_mutex);
  auto it = g_diarization_instances.find(id);
  if (it == g_diarization_instances.end() || !it->second) return nullptr;
  return it->second;
}

std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper>
LookupStreamingDiarization(const std::string& id) {
  std::lock_guard<std::mutex> lock(g_streaming_diarization_mutex);
  auto it = g_streaming_diarization_instances.find(id);
  if (it == g_streaming_diarization_instances.end() || !it->second)
    return nullptr;
  return it->second;
}

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
    // Replace the map entry so in-flight shared_ptrs keep the old wrapper.
    auto inst = std::make_shared<sherpaonnx::DiarizationWrapper>();
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
      g_diarization_instances[instanceIdStr] = std::move(inst);
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
  auto wrapper = LookupDiarization(instanceIdStr);
  if (!wrapper) {
    LOGE("nativeProcessDiarization: instance not found: %s", instanceIdStr.c_str());
    sherpaonnx::DiarizationProcessResult missing;
    missing.success = false;
    missing.errorCode = "DIARIZATION_NOT_INITIALIZED";
    missing.error = "Diarization instance not found: " + instanceIdStr;
    return DiarizationProcessResultToJava(env, missing);
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
  auto wrapper = LookupDiarization(instanceIdStr);
  if (!wrapper) {
    result.success = false;
    result.errorCode = "DIARIZATION_NOT_INITIALIZED";
    result.error = "Diarization instance not found: " + instanceIdStr;
    return DiarizationProcessResultToJava(env, result);
  }
  result = wrapper->recluster(numClusters, threshold);
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
  auto wrapper = LookupDiarization(instanceIdStr);
  if (!wrapper) {
    LOGW("nativeGetClusterEmbeddings: instance not found: %s", instanceIdStr.c_str());
    embeddings.clear();
  } else {
    embeddings = wrapper->getClusterEmbeddings();
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
  auto wrapper = LookupDiarization(instanceIdStr);
  if (wrapper) {
    wrapper->cancel();
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
  std::shared_ptr<sherpaonnx::DiarizationWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(g_diarization_mutex);
    auto it = g_diarization_instances.find(instanceIdStr);
    if (it != g_diarization_instances.end()) {
      if (it->second) {
        it->second->cancel();
      }
      doomed = std::move(it->second);
      g_diarization_instances.erase(it);
    }
  }
  // Destructor releases when last shared_ptr drops (after in-flight process).
}

jobject SegmentListToArrayList(
    JNIEnv* env,
    const std::vector<sherpaonnx::StreamingDiarizationSegmentDto>& segments) {
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

  jobject list = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  if (!list) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }

  for (const auto& s : segments) {
    jobject m = env->NewObject(mapClass, mapInit);
    if (!m) continue;
    PutFloat(env, m, mapPut, "start", s.start);
    PutFloat(env, m, mapPut, "end", s.end);
    PutInt(env, m, mapPut, "speaker", s.speaker);
    env->CallBooleanMethod(list, listAdd, m);
    env->DeleteLocalRef(m);
  }
  env->DeleteLocalRef(mapClass);
  return list;
}

jobject StreamingFeedResultToHashMap(
    JNIEnv* env,
    const sherpaonnx::StreamingDiarizationFeedResult& result) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map || !mapPut) return nullptr;

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  if (!result.error.empty()) {
    sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  }
  if (!result.errorCode.empty()) {
    sherpaonnx::PutString(env, map, mapPut, "errorCode", result.errorCode);
  }

  jobject list = SegmentListToArrayList(env, result.segments);
  if (list) {
    jstring key = env->NewStringUTF("segments");
    env->CallObjectMethod(map, mapPut, key, list);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(list);
  }

  return map;
}

jobject StreamingInitResultToHashMap(
    JNIEnv* env,
    const sherpaonnx::StreamingDiarizationInitResult& result) {
  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map || !mapPut) return nullptr;

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  if (!result.error.empty()) {
    sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  }
  if (!result.errorCode.empty()) {
    sherpaonnx::PutString(env, map, mapPut, "errorCode", result.errorCode);
  }
  PutInt(env, map, mapPut, "sampleRate", result.sampleRate);
  PutInt(env, map, mapPut, "maxSpeakers", result.maxSpeakers);
  PutInt(env, map, mapPut, "feedSamples", result.feedSamples);
  PutInt(env, map, mapPut, "strideSamples", result.strideSamples);
  PutFloat(env, map, mapPut, "latencySeconds", result.latencySeconds);

  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeInitializeStreamingDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jstring modelPath,
    jstring metadataPath,
    jint numThreads,
    jstring provider,
    jboolean debug,
    jfloat onset,
    jfloat offset,
    jfloat padOnset,
    jfloat padOffset,
    jfloat minDurationOn,
    jfloat minDurationOff,
    jint medianWindow
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  const std::string modelPathStr = CopyRequiredJstring(env, modelPath);
  const std::string metadataPathStr = metadataPath ? CopyRequiredJstring(env, metadataPath) : "";
  const auto providerOpt = CopyOptionalJstring(env, provider);

  LOGI("nativeInitializeStreamingDiarization: id=%s model=%s meta=%s threads=%d",
       instanceIdStr.c_str(), modelPathStr.c_str(), metadataPathStr.c_str(),
       static_cast<int>(numThreads));

  auto wrapper = std::make_shared<sherpaonnx::StreamingDiarizationWrapper>();
  auto result = wrapper->initialize(
      modelPathStr,
      metadataPathStr,
      numThreads,
      providerOpt.value_or("cpu"),
      debug,
      onset,
      offset,
      padOnset,
      padOffset,
      minDurationOn,
      minDurationOff,
      medianWindow);

  if (result.success) {
    std::lock_guard<std::mutex> lock(g_streaming_diarization_mutex);
    g_streaming_diarization_instances[instanceIdStr] = wrapper;
  }

  return StreamingInitResultToHashMap(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeFeedStreamingDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jfloatArray samples
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  auto wrapper = LookupStreamingDiarization(instanceIdStr);
  if (!wrapper) {
    sherpaonnx::StreamingDiarizationFeedResult res;
    res.success = false;
    res.error = "Streaming diarization instance not found: " + instanceIdStr;
    res.errorCode = "NOT_INITIALIZED";
    return StreamingFeedResultToHashMap(env, res);
  }

  jsize count = samples ? env->GetArrayLength(samples) : 0;
  std::vector<float> buf;
  if (count > 0) {
    buf.resize(static_cast<size_t>(count));
    env->GetFloatArrayRegion(samples, 0, count, buf.data());
  }

  auto res = wrapper->feed(buf.empty() ? nullptr : buf.data(), buf.size());
  return StreamingFeedResultToHashMap(env, res);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeFlushStreamingDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  auto wrapper = LookupStreamingDiarization(instanceIdStr);
  if (!wrapper) {
    sherpaonnx::StreamingDiarizationFeedResult res;
    res.success = false;
    res.error = "Streaming diarization instance not found: " + instanceIdStr;
    res.errorCode = "NOT_INITIALIZED";
    return StreamingFeedResultToHashMap(env, res);
  }

  auto res = wrapper->flush();
  return StreamingFeedResultToHashMap(env, res);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeResetStreamingDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  auto wrapper = LookupStreamingDiarization(instanceIdStr);
  if (wrapper) {
    wrapper->reset();
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_diarization_facade_SherpaOnnxDiarizationHelper_nativeReleaseStreamingDiarization(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  LOGI("nativeReleaseStreamingDiarization: id=%s", instanceIdStr.c_str());
  std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(g_streaming_diarization_mutex);
    auto it = g_streaming_diarization_instances.find(instanceIdStr);
    if (it != g_streaming_diarization_instances.end()) {
      doomed = std::move(it->second);
      g_streaming_diarization_instances.erase(it);
    }
  }
  if (doomed) {
    doomed->release();
  }
}

}  // extern "C"
