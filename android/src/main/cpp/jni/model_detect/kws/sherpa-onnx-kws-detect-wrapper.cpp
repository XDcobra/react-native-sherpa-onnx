#include "sherpa-onnx-kws-detect-wrapper.h"

#include "sherpa-onnx-detect-jni-common.h"

namespace sherpaonnx {

jobject KwsDetectResultToJava(JNIEnv* env, const KwsDetectResult& result) {
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

  PutBoolean(env, map, mapPut, "success", result.ok);
  PutBoolean(env, map, mapPut, "isStreaming", result.isStreaming);
  PutString(env, map, mapPut, "error", result.error);
  PutString(
      env, map, mapPut, "modelType",
      result.selectedKind == KwsModelKind::kTransducer ? "transducer" : "unknown");

  jobject detected = BuildDetectedModelsList(env, result.detectedModels);
  if (detected) {
    jstring key = env->NewStringUTF("detectedModels");
    env->CallObjectMethod(map, mapPut, key, detected);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(detected);
  }

  std::vector<std::string> sourceStrings;
  for (DetectionSource source : result.detectionSources) {
    sourceStrings.emplace_back(DetectionSourceToLiteral(source));
  }
  jobject sources = BuildStringList(env, sourceStrings);
  if (sources) {
    jstring key = env->NewStringUTF("detectionSources");
    env->CallObjectMethod(map, mapPut, key, sources);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(sources);
  }

  jobject languages = BuildPublicLanguageRowList(env, result.derivedLanguages);
  if (languages) {
    jstring key = env->NewStringUTF("languages");
    env->CallObjectMethod(map, mapPut, key, languages);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(languages);
  }
  PutString(env, map, mapPut, "quantization", result.quantization);

  jclass pathsClass = env->FindClass("java/util/HashMap");
  jobject paths = pathsClass ? env->NewObject(pathsClass, mapInit) : nullptr;
  if (pathsClass) env->DeleteLocalRef(pathsClass);
  if (paths) {
    PutString(env, paths, mapPut, "encoder", result.paths.encoder);
    PutString(env, paths, mapPut, "decoder", result.paths.decoder);
    PutString(env, paths, mapPut, "joiner", result.paths.joiner);
    PutString(env, paths, mapPut, "tokens", result.paths.tokens);
    PutString(env, paths, mapPut, "keywords", result.paths.keywords);
    jstring key = env->NewStringUTF("paths");
    env->CallObjectMethod(map, mapPut, key, paths);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(paths);
  }
  return map;
}

}  // namespace sherpaonnx
