#include "OcrCapabilities.h"
#include "OcrDetect.h"
#include "OcrEngine.h"
#include "OcrTypes.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-model-detect.h"

#include <android/log.h>
#include <jni.h>

#include <string>
#include <vector>

#define TAG "SherpaOnnx:ocr"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

namespace {

std::string JstringToStd(JNIEnv* env, jstring value) {
  if (!value) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (!chars) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!init || !put) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, init);
  env->DeleteLocalRef(mapClass);
  if (outPut) *outPut = put;
  return map;
}

void PutString(JNIEnv* env, jobject map, jmethodID put, const char* key,
               const std::string& value) {
  jstring jkey = env->NewStringUTF(key);
  jstring jval = env->NewStringUTF(value.c_str());
  env->CallObjectMethod(map, put, jkey, jval);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(jval);
}

void PutInt(JNIEnv* env, jobject map, jmethodID put, const char* key, jint value) {
  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID valueOf =
      env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  jobject boxed = env->CallStaticObjectMethod(intClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(intClass);
}

void PutBool(JNIEnv* env, jobject map, jmethodID put, const char* key,
             jboolean value) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  jmethodID valueOf =
      env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(boolClass);
}

void PutDouble(JNIEnv* env, jobject map, jmethodID put, const char* key,
               jdouble value) {
  jclass dblClass = env->FindClass("java/lang/Double");
  jmethodID valueOf =
      env->GetStaticMethodID(dblClass, "valueOf", "(D)Ljava/lang/Double;");
  jobject boxed = env->CallStaticObjectMethod(dblClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(dblClass);
}

jobject NewQuadList(JNIEnv* env, const sherpa_onnx::ocr::OcrQuad& quad) {
  jclass floatClass = env->FindClass("java/lang/Float");
  jmethodID floatValueOf =
      env->GetStaticMethodID(floatClass, "valueOf", "(F)Ljava/lang/Float;");
  jclass listClass = env->FindClass("java/util/ArrayList");
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "(I)V");
  jmethodID listAdd =
      env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jobject quadList = env->NewObject(listClass, listInit, 8);
  for (int i = 0; i < 8; ++i) {
    jobject f = env->CallStaticObjectMethod(floatClass, floatValueOf, quad.xy[i]);
    env->CallBooleanMethod(quadList, listAdd, f);
    env->DeleteLocalRef(f);
  }
  env->DeleteLocalRef(floatClass);
  env->DeleteLocalRef(listClass);
  return quadList;
}

const char* SpanLevelName(sherpa_onnx::ocr::OcrSpanLevel level) {
  switch (level) {
    case sherpa_onnx::ocr::OcrSpanLevel::kWord:
      return "word";
    case sherpa_onnx::ocr::OcrSpanLevel::kBlock:
      return "block";
    case sherpa_onnx::ocr::OcrSpanLevel::kLine:
    default:
      return "line";
  }
}

sherpa_onnx::ocr::OcrGranularity ParseGranularity(const std::string& raw) {
  if (raw == "word") return sherpa_onnx::ocr::OcrGranularity::kWord;
  if (raw == "block") return sherpa_onnx::ocr::OcrGranularity::kBlock;
  return sherpa_onnx::ocr::OcrGranularity::kLine;
}

void ApplyPathOverrides(JNIEnv* env, jobject pathOverrides,
                        sherpa_onnx::ocr::OcrLoadOptions& opts) {
  if (!pathOverrides) return;
  jclass mapClass = env->GetObjectClass(pathOverrides);
  jmethodID get = env->GetMethodID(
      mapClass, "get", "(Ljava/lang/Object;)Ljava/lang/Object;");
  if (!get) {
    env->DeleteLocalRef(mapClass);
    return;
  }
  auto readKey = [&](const char* key) -> std::string {
    jstring jkey = env->NewStringUTF(key);
    jobject val = env->CallObjectMethod(pathOverrides, get, jkey);
    env->DeleteLocalRef(jkey);
    if (!val) return {};
    std::string out = JstringToStd(env, static_cast<jstring>(val));
    env->DeleteLocalRef(val);
    return out;
  };
  opts.path_det = readKey("det");
  opts.path_rec = readKey("rec");
  opts.path_cls = readKey("cls");
  opts.path_rec_dict = readKey("rec_dict");
  opts.path_manifest = readKey("manifest");
  opts.path_vision_encoder = readKey("vision_encoder");
  opts.path_vision_encoder_data = readKey("vision_encoder_data");
  opts.path_embed_tokens = readKey("embed_tokens");
  opts.path_embed_tokens_data = readKey("embed_tokens_data");
  opts.path_embedding = readKey("embedding");
  opts.path_embedding_data = readKey("embedding_data");
  opts.path_decoder = readKey("decoder");
  opts.path_decoder_data = readKey("decoder_data");
  opts.path_tokenizer = readKey("tokenizer");
  opts.path_patch_embed = readKey("patch_embed");
  opts.path_patch_embed_data = readKey("patch_embed_data");
  opts.path_pos_embed = readKey("pos_embed");
  env->DeleteLocalRef(mapClass);
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_sherpaonnx_ocr_OcrNative_nativeLoad(
    JNIEnv* env, jclass /*clazz*/, jstring instanceId, jstring modelDir,
    jstring modelType, jint numThreads, jstring provider, jint maxSideLen,
    jboolean useOrientationCls, jfloat detBoxThresh, jfloat detBoxScoreThresh,
    jfloat detUnclipRatio, jint maxNewTokens, jint maxPixels,
    jstring quantization, jobject pathOverrides) {
  const std::string id = JstringToStd(env, instanceId);
  const std::string dir = JstringToStd(env, modelDir);
  const std::string type = JstringToStd(env, modelType);
  try {
    auto& engine = sherpa_onnx::ocr::OcrEngineRegistry::Instance().Create(id);
    sherpa_onnx::ocr::OcrLoadOptions opts;
    opts.num_threads = numThreads > 0 ? numThreads : 4;
    opts.max_side_len = maxSideLen > 0 ? maxSideLen : 960;
    opts.use_orientation_cls = useOrientationCls == JNI_TRUE;
    opts.det_box_thresh = detBoxThresh;
    opts.det_box_score_thresh = detBoxScoreThresh;
    opts.det_unclip_ratio = detUnclipRatio;
    opts.max_new_tokens = maxNewTokens;
    opts.max_pixels = maxPixels;
    opts.provider = JstringToStd(env, provider);
    opts.quantization = JstringToStd(env, quantization);
    ApplyPathOverrides(env, pathOverrides, opts);
    LOGI("nativeLoad instance=%s type=%s provider=%s threads=%d dir=%s",
         id.c_str(), type.c_str(),
         opts.provider.empty() ? "cpu" : opts.provider.c_str(),
         opts.num_threads, dir.c_str());
    engine.Load(type.empty() ? "auto" : type, dir, opts);
  } catch (const std::exception& e) {
    const char* msg = e.what() ? e.what() : "OCR load failed";
    LOGI("nativeLoad failed instance=%s: %s", id.c_str(), msg);
    jclass ex = env->FindClass("java/lang/RuntimeException");
    if (ex != nullptr) {
      env->ThrowNew(ex, msg);
    }
  } catch (...) {
    LOGI("nativeLoad failed instance=%s: unknown exception", id.c_str());
    jclass ex = env->FindClass("java/lang/RuntimeException");
    if (ex != nullptr) {
      env->ThrowNew(ex, "OCR load failed");
    }
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_ocr_OcrNative_nativeUnload(JNIEnv* env, jclass /*clazz*/,
                                               jstring instanceId) {
  const std::string id = JstringToStd(env, instanceId);
  sherpa_onnx::ocr::OcrEngineRegistry::Instance().Destroy(id);
  LOGI("unload instance=%s", id.c_str());
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_ocr_OcrNative_nativeCancelRecognize(JNIEnv* env,
                                                        jclass /*clazz*/,
                                                        jstring operationId) {
  sherpa_onnx::ocr::OcrCancelRegistry::Instance().RequestCancel(
      JstringToStd(env, operationId));
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_ocr_OcrNative_nativeDetect(JNIEnv* env, jclass /*clazz*/,
                                               jstring modelDir,
                                               jstring modelType,
                                               jstring quantization) {
  const std::string type = JstringToStd(env, modelType);
  auto detect = sherpa_onnx::ocr::DetectOcrModel(
      JstringToStd(env, modelDir), type.empty() ? "auto" : type,
      JstringToStd(env, quantization));
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;
  PutBool(env, map, put, "success", detect.ok ? JNI_TRUE : JNI_FALSE);
  PutBool(env, map, put, "ok", detect.ok ? JNI_TRUE : JNI_FALSE);
  PutString(env, map, put, "modelType", detect.modelType);
  PutString(env, map, put, "family", detect.family);
  PutBool(env, map, put, "hasDet", detect.hasDet ? JNI_TRUE : JNI_FALSE);
  PutBool(env, map, put, "hasRec", detect.hasRec ? JNI_TRUE : JNI_FALSE);
  PutBool(env, map, put, "hasCls", detect.hasCls ? JNI_TRUE : JNI_FALSE);
  PutBool(env, map, put, "hasRecYml", detect.hasRecYml ? JNI_TRUE : JNI_FALSE);
  if (!detect.quantization.empty()) {
    PutString(env, map, put, "quantization", detect.quantization);
  }
  if (!detect.sizeTier.empty()) {
    PutString(env, map, put, "sizeTier", detect.sizeTier);
  }
  if (!detect.errorMessage.empty()) {
    PutString(env, map, put, "error", detect.errorMessage);
  }

  jmethodID pathsPut = nullptr;
  jobject pathsMap = NewHashMap(env, &pathsPut);
  if (pathsMap) {
    if (!detect.detPath.empty()) {
      PutString(env, pathsMap, pathsPut, "det", detect.detPath);
    }
    if (!detect.recPath.empty()) {
      PutString(env, pathsMap, pathsPut, "rec", detect.recPath);
    }
    if (!detect.clsPath.empty()) {
      PutString(env, pathsMap, pathsPut, "cls", detect.clsPath);
    }
    if (!detect.recDictPath.empty()) {
      PutString(env, pathsMap, pathsPut, "rec_dict", detect.recDictPath);
    }
    if (!detect.manifestPath.empty()) {
      PutString(env, pathsMap, pathsPut, "manifest", detect.manifestPath);
    }
    if (!detect.visionEncoderPath.empty()) {
      PutString(env, pathsMap, pathsPut, "vision_encoder",
                detect.visionEncoderPath);
    }
    if (!detect.visionEncoderDataPath.empty()) {
      PutString(env, pathsMap, pathsPut, "vision_encoder_data",
                detect.visionEncoderDataPath);
    }
    if (!detect.embedTokensPath.empty()) {
      PutString(env, pathsMap, pathsPut, "embed_tokens", detect.embedTokensPath);
    }
    if (!detect.embedTokensDataPath.empty()) {
      PutString(env, pathsMap, pathsPut, "embed_tokens_data",
                detect.embedTokensDataPath);
    }
    if (!detect.embeddingPath.empty()) {
      PutString(env, pathsMap, pathsPut, "embedding", detect.embeddingPath);
    }
    if (!detect.embeddingDataPath.empty()) {
      PutString(env, pathsMap, pathsPut, "embedding_data",
                detect.embeddingDataPath);
    }
    if (!detect.decoderPath.empty()) {
      PutString(env, pathsMap, pathsPut, "decoder", detect.decoderPath);
    }
    if (!detect.decoderDataPath.empty()) {
      PutString(env, pathsMap, pathsPut, "decoder_data", detect.decoderDataPath);
    }
    if (!detect.tokenizerPath.empty()) {
      PutString(env, pathsMap, pathsPut, "tokenizer", detect.tokenizerPath);
    }
    if (!detect.patchEmbedPath.empty()) {
      PutString(env, pathsMap, pathsPut, "patch_embed", detect.patchEmbedPath);
    }
    if (!detect.patchEmbedDataPath.empty()) {
      PutString(env, pathsMap, pathsPut, "patch_embed_data",
                detect.patchEmbedDataPath);
    }
    if (!detect.posEmbedPath.empty()) {
      PutString(env, pathsMap, pathsPut, "pos_embed", detect.posEmbedPath);
    }
    jstring key = env->NewStringUTF("paths");
    if (key) {
      env->CallObjectMethod(map, put, key, pathsMap);
      env->DeleteLocalRef(key);
    }
  }

  // Legacy files map with path strings (same keys as before).
  jmethodID filesPut = nullptr;
  jobject filesMap = NewHashMap(env, &filesPut);
  if (filesMap) {
    if (!detect.detPath.empty()) {
      PutString(env, filesMap, filesPut, "det", detect.detPath);
    }
    if (!detect.recPath.empty()) {
      PutString(env, filesMap, filesPut, "rec", detect.recPath);
    }
    if (!detect.clsPath.empty()) {
      PutString(env, filesMap, filesPut, "cls", detect.clsPath);
    }
    if (!detect.recDictPath.empty()) {
      PutString(env, filesMap, filesPut, "recInferenceYml", detect.recDictPath);
    }
    if (!detect.manifestPath.empty()) {
      PutString(env, filesMap, filesPut, "manifest", detect.manifestPath);
    }
    if (!detect.visionEncoderPath.empty()) {
      PutString(env, filesMap, filesPut, "vision_encoder",
                detect.visionEncoderPath);
    }
    if (!detect.visionEncoderDataPath.empty()) {
      PutString(env, filesMap, filesPut, "vision_encoder_data",
                detect.visionEncoderDataPath);
    }
    if (!detect.embedTokensPath.empty()) {
      PutString(env, filesMap, filesPut, "embed_tokens", detect.embedTokensPath);
    }
    if (!detect.embedTokensDataPath.empty()) {
      PutString(env, filesMap, filesPut, "embed_tokens_data",
                detect.embedTokensDataPath);
    }
    if (!detect.embeddingPath.empty()) {
      PutString(env, filesMap, filesPut, "embedding", detect.embeddingPath);
    }
    if (!detect.embeddingDataPath.empty()) {
      PutString(env, filesMap, filesPut, "embedding_data",
                detect.embeddingDataPath);
    }
    if (!detect.decoderPath.empty()) {
      PutString(env, filesMap, filesPut, "decoder", detect.decoderPath);
    }
    if (!detect.decoderDataPath.empty()) {
      PutString(env, filesMap, filesPut, "decoder_data", detect.decoderDataPath);
    }
    if (!detect.tokenizerPath.empty()) {
      PutString(env, filesMap, filesPut, "tokenizer", detect.tokenizerPath);
    }
    if (!detect.patchEmbedPath.empty()) {
      PutString(env, filesMap, filesPut, "patch_embed", detect.patchEmbedPath);
    }
    if (!detect.patchEmbedDataPath.empty()) {
      PutString(env, filesMap, filesPut, "patch_embed_data",
                detect.patchEmbedDataPath);
    }
    if (!detect.posEmbedPath.empty()) {
      PutString(env, filesMap, filesPut, "pos_embed", detect.posEmbedPath);
    }
    jstring key = env->NewStringUTF("files");
    if (key) {
      env->CallObjectMethod(map, put, key, filesMap);
      env->DeleteLocalRef(key);
    }
  }

  jclass arrayListClass = env->FindClass("java/util/ArrayList");
  jmethodID arrayListCtor =
      arrayListClass ? env->GetMethodID(arrayListClass, "<init>", "()V")
                     : nullptr;
  jmethodID arrayListAdd =
      arrayListClass
          ? env->GetMethodID(arrayListClass, "add", "(Ljava/lang/Object;)Z")
          : nullptr;

  if (!detect.detectionSources.empty() && arrayListClass && arrayListCtor &&
      arrayListAdd) {
    jobject sources = env->NewObject(arrayListClass, arrayListCtor);
    if (sources) {
      for (const auto& src : detect.detectionSources) {
        jstring s = env->NewStringUTF(src.c_str());
        if (s) {
          env->CallBooleanMethod(sources, arrayListAdd, s);
          env->DeleteLocalRef(s);
        }
      }
      jstring key = env->NewStringUTF("detectionSources");
      if (key) {
        env->CallObjectMethod(map, put, key, sources);
        env->DeleteLocalRef(key);
      }
    }
  }

  if (arrayListClass && arrayListCtor && arrayListAdd) {
    jobject models = env->NewObject(arrayListClass, arrayListCtor);
    if (models) {
      for (const auto& m : detect.detectedModels) {
        jmethodID entryPut = nullptr;
        jobject entry = NewHashMap(env, &entryPut);
        if (!entry) continue;
        PutString(env, entry, entryPut, "type", m.type);
        PutString(env, entry, entryPut, "modelDir", m.modelDir);
        env->CallBooleanMethod(models, arrayListAdd, entry);
      }
      jstring key = env->NewStringUTF("detectedModels");
      if (key) {
        env->CallObjectMethod(map, put, key, models);
        env->DeleteLocalRef(key);
      }
    }
  }
  if (arrayListClass) env->DeleteLocalRef(arrayListClass);

  if (!detect.languages.empty()) {
    std::vector<sherpaonnx::PublicLanguageRow> rows;
    rows.reserve(detect.languages.size());
    for (const auto& lang : detect.languages) {
      rows.push_back(
          sherpaonnx::PublicLanguageRow{lang.iso6391Hint, lang.id});
    }
    jobject derivedLangs =
        sherpaonnx::BuildPublicLanguageRowList(env, rows);
    if (derivedLangs) {
      jstring keyLang = env->NewStringUTF("languages");
      if (keyLang) {
        env->CallObjectMethod(map, put, keyLang, derivedLangs);
        env->DeleteLocalRef(keyLang);
      }
      env->DeleteLocalRef(derivedLangs);
    }
  }

  PutString(env, map, put, "errorCode", detect.errorCode);
  PutString(env, map, put, "errorMessage", detect.errorMessage);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_ocr_OcrNative_nativeRecognize(
    JNIEnv* env, jclass /*clazz*/, jstring instanceId, jstring imageBufferId,
    jintArray frameIndices, jstring granularity, jstring operationId,
    jint progressMinIntervalMs, jstring recognizeSpec) {
  const std::string id = JstringToStd(env, instanceId);
  const std::string imageId = JstringToStd(env, imageBufferId);
  const std::string opId = JstringToStd(env, operationId);
  const std::string gran = JstringToStd(env, granularity);

  auto* engine = sherpa_onnx::ocr::OcrEngineRegistry::Instance().Get(id);
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;

  if (!engine) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "OCR_INSTANCE_NOT_FOUND");
    PutString(env, map, put, "errorMessage", "OCR instance not found: " + id);
    return map;
  }

  sherpa_onnx::ocr::OcrEngine::RecognizeOptions opts;
  opts.granularity = ParseGranularity(gran);
  opts.progress_min_interval_ms =
      progressMinIntervalMs < 0 ? 0 : static_cast<int>(progressMinIntervalMs);
  opts.recognize_spec = JstringToStd(env, recognizeSpec);
  if (frameIndices != nullptr) {
    const jsize n = env->GetArrayLength(frameIndices);
    jint* elems = env->GetIntArrayElements(frameIndices, nullptr);
    if (elems) {
      opts.frame_indices.assign(elems, elems + n);
      env->ReleaseIntArrayElements(frameIndices, elems, JNI_ABORT);
    }
  }

  if (!opId.empty()) {
    sherpa_onnx::ocr::OcrCancelRegistry::Instance().Begin(opId);
    opts.cancel = [opId]() {
      return sherpa_onnx::ocr::OcrCancelRegistry::Instance().IsCancelled(opId);
    };
  }

  JavaVM* jvm = nullptr;
  env->GetJavaVM(&jvm);
  jclass progressClass = env->FindClass("com/sherpaonnx/ocr/OcrNative");
  jmethodID progressMethod =
      progressClass
          ? env->GetStaticMethodID(progressClass, "onNativeProgress",
                                   "(Ljava/lang/String;IILjava/lang/String;II)V")
          : nullptr;
  jobject globalClass =
      progressClass ? env->NewGlobalRef(progressClass) : nullptr;
  if (progressClass) env->DeleteLocalRef(progressClass);

  if (jvm && globalClass && progressMethod && !opId.empty()) {
    opts.progress = [jvm, globalClass, progressMethod, opId](
                        const sherpa_onnx::ocr::OcrProgressTick& tick) {
      JNIEnv* cbEnv = nullptr;
      bool attached = false;
      if (jvm->GetEnv(reinterpret_cast<void**>(&cbEnv), JNI_VERSION_1_6) !=
          JNI_OK) {
        if (jvm->AttachCurrentThread(&cbEnv, nullptr) != 0) return;
        attached = true;
      }
      jstring jop = cbEnv->NewStringUTF(opId.c_str());
      jstring jphase = cbEnv->NewStringUTF(tick.phase.c_str());
      cbEnv->CallStaticVoidMethod(static_cast<jclass>(globalClass), progressMethod, jop,
                                  tick.done, tick.total, jphase, tick.frame_index,
                                  tick.frame_count);
      cbEnv->DeleteLocalRef(jop);
      cbEnv->DeleteLocalRef(jphase);
      if (attached) jvm->DetachCurrentThread();
    };
  }

  auto outcome = engine->RecognizeMulti(imageId, opts);
  if (globalClass) env->DeleteGlobalRef(globalClass);
  if (!opId.empty()) {
    sherpa_onnx::ocr::OcrCancelRegistry::Instance().End(opId);
  }

  PutBool(env, map, put, "ok", outcome.ok ? JNI_TRUE : JNI_FALSE);
  PutBool(env, map, put, "cancelled", outcome.cancelled ? JNI_TRUE : JNI_FALSE);
  PutString(env, map, put, "errorCode", outcome.errorCode);
  PutString(env, map, put, "errorMessage", outcome.errorMessage);
  PutString(env, map, put, "family", outcome.family);
  PutString(env, map, put, "text", outcome.result.text_utf8);
  PutString(env, map, put, "raw", outcome.result.raw_utf8);
  PutString(env, map, put, "instructionSpec", outcome.result.instruction_spec);
  if (sherpa_onnx::ocr::IsOcrVlmFamily(outcome.family)) {
    PutString(env, map, put, "stopReason", outcome.result.stop_reason);
    PutBool(env, map, put, "complete", outcome.result.complete ? JNI_TRUE : JNI_FALSE);
  }
  if (outcome.result.has_content) {
    jmethodID contentPut = nullptr;
    jobject contentMap = NewHashMap(env, &contentPut);
    if (contentMap) {
      PutString(env, contentMap, contentPut, "format",
                sherpa_onnx::ocr::OcrContentFormatName(outcome.result.content.format));
      PutString(env, contentMap, contentPut, "value", outcome.result.content.value);
      if (!outcome.result.content.language.empty()) {
        PutString(env, contentMap, contentPut, "language",
                  outcome.result.content.language);
      }
      jstring contentKey = env->NewStringUTF("content");
      env->CallObjectMethod(map, put, contentKey, contentMap);
      env->DeleteLocalRef(contentKey);
      env->DeleteLocalRef(contentMap);
    }
  }

  jclass arrayListClass = env->FindClass("java/util/ArrayList");
  jmethodID arrayListInit = env->GetMethodID(arrayListClass, "<init>", "()V");
  jmethodID arrayListAdd =
      env->GetMethodID(arrayListClass, "add", "(Ljava/lang/Object;)Z");
  jobject spansList = env->NewObject(arrayListClass, arrayListInit);

  for (const auto& span : outcome.result.spans) {
    jmethodID spanPut = nullptr;
    jobject spanMap = NewHashMap(env, &spanPut);
    if (!spanMap) continue;
    PutInt(env, spanMap, spanPut, "utf16Start", span.utf16_start);
    PutInt(env, spanMap, spanPut, "utf16End", span.utf16_end);
    PutString(env, spanMap, spanPut, "level", SpanLevelName(span.level));
    PutInt(env, spanMap, spanPut, "frameIndex", span.frame_index);
    PutDouble(env, spanMap, spanPut, "confidence",
              static_cast<double>(span.confidence));

    jobject quadList = NewQuadList(env, span.quad);
    jstring qkey = env->NewStringUTF("quad");
    env->CallObjectMethod(spanMap, spanPut, qkey, quadList);
    env->DeleteLocalRef(qkey);
    env->DeleteLocalRef(quadList);

    env->CallBooleanMethod(spansList, arrayListAdd, spanMap);
    env->DeleteLocalRef(spanMap);
  }

  jstring spansKey = env->NewStringUTF("spans");
  env->CallObjectMethod(map, put, spansKey, spansList);
  env->DeleteLocalRef(spansKey);
  env->DeleteLocalRef(spansList);

  jobject elementsList = env->NewObject(arrayListClass, arrayListInit);
  for (const auto& element : outcome.result.elements) {
    jmethodID elementPut = nullptr;
    jobject elementMap = NewHashMap(env, &elementPut);
    if (!elementMap) continue;
    PutString(env, elementMap, elementPut, "kind",
              sherpa_onnx::ocr::OcrElementKindName(element.kind));
    PutInt(env, elementMap, elementPut, "frameIndex", element.frame_index);
    if (element.has_quad) {
      jobject quadList = NewQuadList(env, element.quad);
      jstring qkey = env->NewStringUTF("quad");
      env->CallObjectMethod(elementMap, elementPut, qkey, quadList);
      env->DeleteLocalRef(qkey);
      env->DeleteLocalRef(quadList);
    }
    if (element.has_utf16) {
      PutInt(env, elementMap, elementPut, "utf16Start", element.utf16_start);
      PutInt(env, elementMap, elementPut, "utf16End", element.utf16_end);
    }
    if (element.heading_level) {
      PutInt(env, elementMap, elementPut, "headingLevel", *element.heading_level);
    }
    if (element.checked) {
      PutBool(env, elementMap, elementPut, "checked",
              *element.checked ? JNI_TRUE : JNI_FALSE);
    }
    env->CallBooleanMethod(elementsList, arrayListAdd, elementMap);
    env->DeleteLocalRef(elementMap);
  }
  jstring elementsKey = env->NewStringUTF("elements");
  env->CallObjectMethod(map, put, elementsKey, elementsList);
  env->DeleteLocalRef(elementsKey);
  env->DeleteLocalRef(elementsList);
  env->DeleteLocalRef(arrayListClass);

  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_ocr_OcrNative_nativeGetCapabilities(JNIEnv* env,
                                                        jclass /*clazz*/,
                                                        jstring instanceId) {
  const std::string id = JstringToStd(env, instanceId);
  auto* engine = sherpa_onnx::ocr::OcrEngineRegistry::Instance().Get(id);
  if (!engine || !engine->IsLoaded()) return nullptr;
  const char* family = engine->Family();
  if (!family || family[0] == '\0') return nullptr;
  const auto caps = sherpa_onnx::ocr::CapabilitiesForFamily(family);
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;
  PutString(env, map, put, "family", family);
  PutBool(env, map, put, "supportsCrop",
          caps.supports_crop ? JNI_TRUE : JNI_FALSE);
  PutBool(env, map, put, "producesElements",
          caps.produces_elements ? JNI_TRUE : JNI_FALSE);

  jclass listClass = env->FindClass("java/util/ArrayList");
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd =
      env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jobject tasks = env->NewObject(listClass, listInit);
  for (const auto& task : caps.tasks) {
    jstring item = env->NewStringUTF(task.c_str());
    env->CallBooleanMethod(tasks, listAdd, item);
    env->DeleteLocalRef(item);
  }
  jstring tasksKey = env->NewStringUTF("tasks");
  env->CallObjectMethod(map, put, tasksKey, tasks);
  env->DeleteLocalRef(tasksKey);
  env->DeleteLocalRef(tasks);

  jobject granularities = env->NewObject(listClass, listInit);
  for (const auto g : caps.granularities) {
    jstring item =
        env->NewStringUTF(sherpa_onnx::ocr::GranularityName(g));
    env->CallBooleanMethod(granularities, listAdd, item);
    env->DeleteLocalRef(item);
  }
  jstring granKey = env->NewStringUTF("granularities");
  env->CallObjectMethod(map, put, granKey, granularities);
  env->DeleteLocalRef(granKey);
  env->DeleteLocalRef(granularities);
  env->DeleteLocalRef(listClass);
  return map;
}

}  // extern "C"
