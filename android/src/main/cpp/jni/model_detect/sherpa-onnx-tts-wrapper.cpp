/**
 * sherpa-onnx-tts-wrapper.cpp
 *
 * Purpose: Converts C++ TtsDetectResult to a Java HashMap for nativeDetectTtsModel. Contains
 * TTS model kind string mapping and path marshalling. Used by sherpa-onnx-module-jni.cpp.
 */
#include "sherpa-onnx-tts-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

namespace {

const char* TtsModelKindToString(TtsModelKind k) {
  switch (k) {
    case TtsModelKind::kVits: return "vits";
    case TtsModelKind::kMatcha: return "matcha";
    case TtsModelKind::kKokoro: return "kokoro";
    case TtsModelKind::kKitten: return "kitten";
    case TtsModelKind::kPocket: return "pocket";
    case TtsModelKind::kZipvoice: return "zipvoice";
    default: return "unknown";
  }
}

}  // namespace

jobject TtsDetectResultToJava(JNIEnv* env, const TtsDetectResult& result) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, mapInit);
  env->DeleteLocalRef(mapClass);
  if (!map) return nullptr;

  PutBoolean(env, map, mapPut, "success", result.ok);
  PutString(env, map, mapPut, "error", result.error);
  PutString(env, map, mapPut, "modelType", TtsModelKindToString(result.selectedKind));

  jobject detectedList = BuildDetectedModelsList(env, result.detectedModels);
  if (detectedList) {
    env->CallObjectMethod(map, mapPut, env->NewStringUTF("detectedModels"), detectedList);
    env->DeleteLocalRef(detectedList);
  }

  jclass hashMapClass = env->FindClass("java/util/HashMap");
  if (hashMapClass) {
    jobject pathsMap = env->NewObject(hashMapClass, mapInit);
    env->DeleteLocalRef(hashMapClass);
    if (pathsMap) {
      PutString(env, pathsMap, mapPut, "ttsModel", result.paths.ttsModel);
      PutString(env, pathsMap, mapPut, "tokens", result.paths.tokens);
      PutString(env, pathsMap, mapPut, "lexicon", result.paths.lexicon);
      PutString(env, pathsMap, mapPut, "dataDir", result.paths.dataDir);
      PutString(env, pathsMap, mapPut, "voices", result.paths.voices);
      PutString(env, pathsMap, mapPut, "acousticModel", result.paths.acousticModel);
      PutString(env, pathsMap, mapPut, "vocoder", result.paths.vocoder);
      PutString(env, pathsMap, mapPut, "encoder", result.paths.encoder);
      PutString(env, pathsMap, mapPut, "decoder", result.paths.decoder);
      PutString(env, pathsMap, mapPut, "lmFlow", result.paths.lmFlow);
      PutString(env, pathsMap, mapPut, "lmMain", result.paths.lmMain);
      PutString(env, pathsMap, mapPut, "textConditioner", result.paths.textConditioner);
      PutString(env, pathsMap, mapPut, "vocabJson", result.paths.vocabJson);
      PutString(env, pathsMap, mapPut, "tokenScoresJson", result.paths.tokenScoresJson);
      env->CallObjectMethod(map, mapPut, env->NewStringUTF("paths"), pathsMap);
      env->DeleteLocalRef(pathsMap);
    }
  }
  return map;
}

}  // namespace sherpaonnx
