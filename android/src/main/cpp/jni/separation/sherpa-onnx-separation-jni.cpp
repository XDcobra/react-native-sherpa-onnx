#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-separation-wrapper.h"

#include <android/log.h>
#include <jni.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

#define SEPARATION_JNI_TAG "SherpaOnnxSeparationJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, SEPARATION_JNI_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, SEPARATION_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, SEPARATION_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_separation_mutex;
std::unordered_map<std::string, std::unique_ptr<sherpaonnx::SeparationWrapper>>
    g_separation_instances;

std::optional<std::string> CopyOptionalJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return std::nullopt;
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return std::nullopt;
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  if (out.empty()) return std::nullopt;
  return out;
}

std::string CopyRequiredJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jobject SeparationInitializeResultToJava(
    JNIEnv* env,
    const sherpaonnx::SeparationInitializeResult& result
) {
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

  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "modelType", result.modelType);

  jobject detectedList = sherpaonnx::BuildDetectedModelsList(env, result.detectedModels);
  if (detectedList) {
    jstring keyDetected = env->NewStringUTF("detectedModels");
    env->CallObjectMethod(map, mapPut, keyDetected, detectedList);
    env->DeleteLocalRef(keyDetected);
    env->DeleteLocalRef(detectedList);
  }

  if (result.sampleRate > 0) {
    jclass intClass = env->FindClass("java/lang/Integer");
    jmethodID intValueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
    jobject sampleRateObj = env->CallStaticObjectMethod(intClass, intValueOf, result.sampleRate);
    jstring keySampleRate = env->NewStringUTF("sampleRate");
    env->CallObjectMethod(map, mapPut, keySampleRate, sampleRateObj);
    env->DeleteLocalRef(keySampleRate);
    env->DeleteLocalRef(sampleRateObj);
    env->DeleteLocalRef(intClass);
  }

  if (result.numStems > 0) {
    jclass intClass = env->FindClass("java/lang/Integer");
    jmethodID intValueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
    jobject numStemsObj = env->CallStaticObjectMethod(intClass, intValueOf, result.numStems);
    jstring keyNumStems = env->NewStringUTF("numStems");
    env->CallObjectMethod(map, mapPut, keyNumStems, numStemsObj);
    env->DeleteLocalRef(keyNumStems);
    env->DeleteLocalRef(numStemsObj);
    env->DeleteLocalRef(intClass);
  }

  return map;
}

sherpaonnx::SeparationWrapper* GetSeparationWrapperOrNull(const std::string& instanceId) {
  std::lock_guard<std::mutex> lock(g_separation_mutex);
  auto it = g_separation_instances.find(instanceId);
  if (it == g_separation_instances.end() || it->second == nullptr) {
    return nullptr;
  }
  return it->second.get();
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_separation_facade_SherpaOnnxSeparationHelper_nativeInitializeSeparationAuto(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jstring modelDir,
    jstring modelType,
    jint numThreads,
    jstring provider,
    jboolean debug
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  const std::string modelDirStr = CopyRequiredJstring(env, modelDir);
  const std::string modelTypeStr = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  LOGI(
      "nativeInitializeSeparationAuto: instanceId=%s modelDir=%s modelType=%s threads=%d",
      instanceIdStr.c_str(),
      modelDirStr.c_str(),
      modelTypeStr.c_str(),
      numThreads
  );

  sherpaonnx::SeparationInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_separation_mutex);
    auto& inst = g_separation_instances[instanceIdStr];
    if (inst == nullptr) {
      inst = std::make_unique<sherpaonnx::SeparationWrapper>();
    } else {
      inst->release();
    }
    result = inst->initialize(
        modelDirStr,
        modelTypeStr.empty() ? "auto" : modelTypeStr,
        numThreads > 0 ? numThreads : 1,
        providerOpt,
        debug == JNI_TRUE
    );
    if (!result.success) {
      LOGE(
          "nativeInitializeSeparationAuto failed: instanceId=%s error=%s",
          instanceIdStr.c_str(),
          result.error.c_str()
      );
      g_separation_instances.erase(instanceIdStr);
    } else {
      LOGI(
          "nativeInitializeSeparationAuto ok: instanceId=%s sampleRate=%d numStems=%d",
          instanceIdStr.c_str(),
          result.sampleRate,
          result.numStems
      );
    }
  }
  return SeparationInitializeResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_separation_facade_SherpaOnnxSeparationHelper_nativeInitializeSeparationCustom(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jstring modelType,
    jobject modelPaths,
    jint numThreads,
    jstring provider,
    jboolean debug
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  const std::string modelTypeStr = CopyRequiredJstring(env, modelType);
  const auto providerOpt = CopyOptionalJstring(env, provider);

  sherpaonnx::SeparationModelPaths paths;
  sherpaonnx::FillSeparationModelPathsFromStringMap(
      sherpaonnx::JavaHashMapToStringMap(env, modelPaths),
      paths
  );

  LOGI(
      "nativeInitializeSeparationCustom: instanceId=%s modelType=%s threads=%d",
      instanceIdStr.c_str(),
      modelTypeStr.c_str(),
      numThreads
  );

  sherpaonnx::SeparationInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_separation_mutex);
    auto& inst = g_separation_instances[instanceIdStr];
    if (inst == nullptr) {
      inst = std::make_unique<sherpaonnx::SeparationWrapper>();
    } else {
      inst->release();
    }
    result = inst->initializeCustom(
        modelTypeStr,
        paths,
        numThreads > 0 ? numThreads : 1,
        providerOpt,
        debug == JNI_TRUE
    );
    if (!result.success) {
      LOGE(
          "nativeInitializeSeparationCustom failed: instanceId=%s error=%s",
          instanceIdStr.c_str(),
          result.error.c_str()
      );
      g_separation_instances.erase(instanceIdStr);
    } else {
      LOGI(
          "nativeInitializeSeparationCustom ok: instanceId=%s sampleRate=%d numStems=%d",
          instanceIdStr.c_str(),
          result.sampleRate,
          result.numStems
      );
    }
  }
  return SeparationInitializeResultToJava(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_separation_facade_SherpaOnnxSeparationHelper_nativeProcessSeparation(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId,
    jfloatArray samples,
    jint sampleRate
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  sherpaonnx::SeparationWrapper* wrapper = GetSeparationWrapperOrNull(instanceIdStr);
  if (wrapper == nullptr) {
    LOGE("nativeProcessSeparation: instance not found: %s", instanceIdStr.c_str());
    return nullptr;
  }

  jsize n = env->GetArrayLength(samples);
  if (n <= 0 || sampleRate <= 0) {
    LOGE(
        "nativeProcessSeparation: invalid input instanceId=%s n=%d sampleRate=%d",
        instanceIdStr.c_str(),
        static_cast<int>(n),
        sampleRate
    );
    return nullptr;
  }
  LOGI(
      "nativeProcessSeparation: instanceId=%s n=%d sampleRate=%d",
      instanceIdStr.c_str(),
      static_cast<int>(n),
      sampleRate
  );
  std::vector<float> input(static_cast<size_t>(n));
  env->GetFloatArrayRegion(samples, 0, n, input.data());

  sherpaonnx::SeparationProcessResult result =
      wrapper->processMonoSamples(input, sampleRate);
  if (!result.success) {
    LOGE("nativeProcessSeparation failed: %s", result.error.c_str());
    return nullptr;
  }
  LOGI(
      "nativeProcessSeparation ok: instanceId=%s stems=%zu",
      instanceIdStr.c_str(),
      result.stems.size()
  );

  jclass floatArrayClass = env->FindClass("[F");
  if (!floatArrayClass) return nullptr;
  jobjectArray out =
      env->NewObjectArray(static_cast<jsize>(result.stems.size()), floatArrayClass, nullptr);
  env->DeleteLocalRef(floatArrayClass);
  if (!out) return nullptr;

  for (jsize i = 0; i < static_cast<jsize>(result.stems.size()); ++i) {
    const auto& stem = result.stems[static_cast<size_t>(i)];
    jfloatArray stemArray = env->NewFloatArray(static_cast<jsize>(stem.samples.size()));
    if (!stemArray) return nullptr;
    if (!stem.samples.empty()) {
      env->SetFloatArrayRegion(
          stemArray, 0, static_cast<jsize>(stem.samples.size()), stem.samples.data()
      );
    }
    env->SetObjectArrayElement(out, i, stemArray);
    env->DeleteLocalRef(stemArray);
  }
  return out;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_separation_facade_SherpaOnnxSeparationHelper_nativeGetSeparationSampleRate(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  sherpaonnx::SeparationWrapper* wrapper = GetSeparationWrapperOrNull(instanceIdStr);
  if (wrapper == nullptr) return 0;
  return wrapper->getSampleRate();
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_separation_facade_SherpaOnnxSeparationHelper_nativeGetSeparationNumStems(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  sherpaonnx::SeparationWrapper* wrapper = GetSeparationWrapperOrNull(instanceIdStr);
  if (wrapper == nullptr) return 0;
  return wrapper->getNumStems();
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_separation_facade_SherpaOnnxSeparationHelper_nativeReleaseSeparation(
    JNIEnv* env,
    jclass /* clazz */,
    jstring instanceId
) {
  const std::string instanceIdStr = CopyRequiredJstring(env, instanceId);
  LOGI("nativeReleaseSeparation: instanceId=%s", instanceIdStr.c_str());
  std::lock_guard<std::mutex> lock(g_separation_mutex);
  auto it = g_separation_instances.find(instanceIdStr);
  if (it != g_separation_instances.end()) {
    if (it->second != nullptr) {
      it->second->release();
    }
    g_separation_instances.erase(it);
  }
}

}  // extern "C"
