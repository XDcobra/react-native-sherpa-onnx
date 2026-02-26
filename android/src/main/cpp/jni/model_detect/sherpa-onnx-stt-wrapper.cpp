/**
 * sherpa-onnx-stt-wrapper.cpp
 *
 * Purpose: Converts C++ SttDetectResult to a Java HashMap for nativeDetectSttModel. Contains
 * STT model kind string mapping and path marshalling. Used by sherpa-onnx-module-jni.cpp.
 */
#include "sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

namespace {

const char* SttModelKindToString(SttModelKind k) {
  switch (k) {
    case SttModelKind::kTransducer: return "transducer";
    case SttModelKind::kNemoTransducer: return "nemo_transducer";
    case SttModelKind::kParaformer: return "paraformer";
    case SttModelKind::kNemoCtc: return "nemo_ctc";
    case SttModelKind::kWenetCtc: return "wenet_ctc";
    case SttModelKind::kSenseVoice: return "sense_voice";
    case SttModelKind::kZipformerCtc: return "zipformer_ctc";
    case SttModelKind::kWhisper: return "whisper";
    case SttModelKind::kFunAsrNano: return "funasr_nano";
    case SttModelKind::kFireRedAsr: return "fire_red_asr";
    case SttModelKind::kMoonshine: return "moonshine";
    case SttModelKind::kDolphin: return "dolphin";
    case SttModelKind::kCanary: return "canary";
    case SttModelKind::kOmnilingual: return "omnilingual";
    case SttModelKind::kMedAsr: return "medasr";
    case SttModelKind::kTeleSpeechCtc: return "telespeech_ctc";
    default: return "unknown";
  }
}

}  // namespace

jobject SttDetectResultToJava(JNIEnv* env, const SttDetectResult& result) {
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
  PutString(env, map, mapPut, "modelType", SttModelKindToString(result.selectedKind));

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
      PutString(env, pathsMap, mapPut, "encoder", result.paths.encoder);
      PutString(env, pathsMap, mapPut, "decoder", result.paths.decoder);
      PutString(env, pathsMap, mapPut, "joiner", result.paths.joiner);
      PutString(env, pathsMap, mapPut, "tokens", result.paths.tokens);
      PutString(env, pathsMap, mapPut, "paraformerModel", result.paths.paraformerModel);
      PutString(env, pathsMap, mapPut, "ctcModel", result.paths.ctcModel);
      PutString(env, pathsMap, mapPut, "whisperEncoder", result.paths.whisperEncoder);
      PutString(env, pathsMap, mapPut, "whisperDecoder", result.paths.whisperDecoder);
      PutString(env, pathsMap, mapPut, "funasrEncoderAdaptor", result.paths.funasrEncoderAdaptor);
      PutString(env, pathsMap, mapPut, "funasrLLM", result.paths.funasrLLM);
      PutString(env, pathsMap, mapPut, "funasrEmbedding", result.paths.funasrEmbedding);
      PutString(env, pathsMap, mapPut, "funasrTokenizer", result.paths.funasrTokenizer);
      PutString(env, pathsMap, mapPut, "moonshinePreprocessor", result.paths.moonshinePreprocessor);
      PutString(env, pathsMap, mapPut, "moonshineEncoder", result.paths.moonshineEncoder);
      PutString(env, pathsMap, mapPut, "moonshineUncachedDecoder", result.paths.moonshineUncachedDecoder);
      PutString(env, pathsMap, mapPut, "moonshineCachedDecoder", result.paths.moonshineCachedDecoder);
      PutString(env, pathsMap, mapPut, "dolphinModel", result.paths.dolphinModel);
      PutString(env, pathsMap, mapPut, "omnilingualModel", result.paths.omnilingualModel);
      PutString(env, pathsMap, mapPut, "medasrModel", result.paths.medasrModel);
      PutString(env, pathsMap, mapPut, "telespeechCtcModel", result.paths.telespeechCtcModel);
      PutString(env, pathsMap, mapPut, "fireRedEncoder", result.paths.fireRedEncoder);
      PutString(env, pathsMap, mapPut, "fireRedDecoder", result.paths.fireRedDecoder);
      PutString(env, pathsMap, mapPut, "canaryEncoder", result.paths.canaryEncoder);
      PutString(env, pathsMap, mapPut, "canaryDecoder", result.paths.canaryDecoder);
      PutString(env, pathsMap, mapPut, "bpeVocab", result.paths.bpeVocab);
      env->CallObjectMethod(map, mapPut, env->NewStringUTF("paths"), pathsMap);
      env->DeleteLocalRef(pathsMap);
    }
  }
  return map;
}

}  // namespace sherpaonnx
