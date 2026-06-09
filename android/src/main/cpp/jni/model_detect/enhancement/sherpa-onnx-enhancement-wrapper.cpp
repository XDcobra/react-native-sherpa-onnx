#include "sherpa-onnx-enhancement-wrapper.h"

#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {
namespace {

const char* EnhancementModelKindToString(EnhancementModelKind k) {
  switch (k) {
    case EnhancementModelKind::kGtcrn:
      return "gtcrn";
    case EnhancementModelKind::kDpdfNet:
      return "dpdfnet";
    default:
      return "unknown";
  }
}

} // namespace

jobject EnhancementDetectResultToJava(
    JNIEnv* env,
    const EnhancementDetectResult& result
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

  PutBoolean(env, map, mapPut, "success", result.ok);
  PutBoolean(env, map, mapPut, "isStreaming", result.isStreaming);
  PutString(env, map, mapPut, "error", result.error);
  PutString(env, map, mapPut, "modelType",
            EnhancementModelKindToString(result.selectedKind));

  jobject detectedList = BuildDetectedModelsList(env, result.detectedModels);
  if (detectedList) {
    jstring keyDetected = env->NewStringUTF("detectedModels");
    env->CallObjectMethod(map, mapPut, keyDetected, detectedList);
    env->DeleteLocalRef(keyDetected);
    env->DeleteLocalRef(detectedList);
  }

  std::vector<std::string> detectionSourceStrings;
  detectionSourceStrings.reserve(result.detectionSources.size());
  for (DetectionSource s : result.detectionSources) {
    detectionSourceStrings.emplace_back(DetectionSourceToLiteral(s));
  }
  jobject detectionSourcesList = BuildStringList(env, detectionSourceStrings);
  if (detectionSourcesList) {
    jstring keyDetectionSources = env->NewStringUTF("detectionSources");
    env->CallObjectMethod(map, mapPut, keyDetectionSources, detectionSourcesList);
    env->DeleteLocalRef(keyDetectionSources);
    env->DeleteLocalRef(detectionSourcesList);
  }

  jobject derivedLangs = BuildPublicLanguageRowList(env, result.derivedLanguages);
  if (derivedLangs) {
    jstring keyLang = env->NewStringUTF("languages");
    env->CallObjectMethod(map, mapPut, keyLang, derivedLangs);
    env->DeleteLocalRef(keyLang);
    env->DeleteLocalRef(derivedLangs);
  }
  PutString(env, map, mapPut, "quantization", result.quantization);

  jclass hashMapClass = env->FindClass("java/util/HashMap");
  if (hashMapClass) {
    jobject pathsMap = env->NewObject(hashMapClass, mapInit);
    env->DeleteLocalRef(hashMapClass);
    if (pathsMap) {
      PutString(env, pathsMap, mapPut, "model", result.paths.model);
      jstring keyPaths = env->NewStringUTF("paths");
      env->CallObjectMethod(map, mapPut, keyPaths, pathsMap);
      env->DeleteLocalRef(keyPaths);
      env->DeleteLocalRef(pathsMap);
    }
  }

  return map;
}

} // namespace sherpaonnx
