// JNI for SherpaOnnxModule: test init + model detection (STT/TTS). Used by Kotlin to build Kotlin API config.
#include <jni.h>
#include <string>
#include <optional>

#if defined(__ANDROID__)
#include <dlfcn.h>
#include <android/log.h>
#include <cstdint>
#endif

#define NNAPI_LOG_TAG "SherpaOnnx"

#include "sherpa-onnx-model-detect.h"

namespace {

// Put a string entry into a Java HashMap. Returns false on failure.
bool putString(JNIEnv* env, jobject map, jmethodID putId, const char* key, const std::string& value) {
  jstring jkey = env->NewStringUTF(key);
  if (!jkey) return false;
  jstring jval = value.empty() ? nullptr : env->NewStringUTF(value.c_str());
  if (!value.empty() && !jval) {
    env->DeleteLocalRef(jkey);
    return false;
  }
  env->CallObjectMethod(map, putId, jkey, jval ? static_cast<jobject>(jval) : nullptr);
  env->DeleteLocalRef(jkey);
  if (jval) env->DeleteLocalRef(jval);
  return true;
}

// Put a boolean entry. Uses Boolean.valueOf(boolean).
bool putBoolean(JNIEnv* env, jobject map, jmethodID putId, const char* key, bool value) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  if (!boolClass) return false;
  jmethodID valueOf = env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  if (!valueOf) {
    env->DeleteLocalRef(boolClass);
    return false;
  }
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, value ? JNI_TRUE : JNI_FALSE);
  env->DeleteLocalRef(boolClass);
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

// Build detectedModels ArrayList from C++ vector<DetectedModel>.
jobject buildDetectedModelsList(JNIEnv* env, const std::vector<sherpaonnx::DetectedModel>& models) {
  jclass listClass = env->FindClass("java/util/ArrayList");
  if (!listClass) return nullptr;
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  if (!listInit || !listAdd) {
    env->DeleteLocalRef(listClass);
    return nullptr;
  }
  jobject list = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  if (!list) return nullptr;

  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) {
    env->DeleteLocalRef(list);
    return nullptr;
  }
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    env->DeleteLocalRef(list);
    return nullptr;
  }

  for (const auto& m : models) {
    jobject modelMap = env->NewObject(mapClass, mapInit);
    if (!modelMap) continue;
    putString(env, modelMap, mapPut, "type", m.type);
    putString(env, modelMap, mapPut, "modelDir", m.modelDir);
    env->CallBooleanMethod(list, listAdd, modelMap);
    env->DeleteLocalRef(modelMap);
  }
  env->DeleteLocalRef(mapClass);
  return list;
}

const char* sttModelKindToString(sherpaonnx::SttModelKind k) {
  switch (k) {
    case sherpaonnx::SttModelKind::kTransducer: return "transducer";
    case sherpaonnx::SttModelKind::kNemoTransducer: return "nemo_transducer";
    case sherpaonnx::SttModelKind::kParaformer: return "paraformer";
    case sherpaonnx::SttModelKind::kNemoCtc: return "nemo_ctc";
    case sherpaonnx::SttModelKind::kWenetCtc: return "wenet_ctc";
    case sherpaonnx::SttModelKind::kSenseVoice: return "sense_voice";
    case sherpaonnx::SttModelKind::kZipformerCtc: return "zipformer_ctc";
    case sherpaonnx::SttModelKind::kWhisper: return "whisper";
    case sherpaonnx::SttModelKind::kFunAsrNano: return "funasr_nano";
    case sherpaonnx::SttModelKind::kFireRedAsr: return "fire_red_asr";
    case sherpaonnx::SttModelKind::kMoonshine: return "moonshine";
    case sherpaonnx::SttModelKind::kDolphin: return "dolphin";
    case sherpaonnx::SttModelKind::kCanary: return "canary";
    case sherpaonnx::SttModelKind::kOmnilingual: return "omnilingual";
    case sherpaonnx::SttModelKind::kMedAsr: return "medasr";
    case sherpaonnx::SttModelKind::kTeleSpeechCtc: return "telespeech_ctc";
    default: return "unknown";
  }
}

const char* ttsModelKindToString(sherpaonnx::TtsModelKind k) {
  switch (k) {
    case sherpaonnx::TtsModelKind::kVits: return "vits";
    case sherpaonnx::TtsModelKind::kMatcha: return "matcha";
    case sherpaonnx::TtsModelKind::kKokoro: return "kokoro";
    case sherpaonnx::TtsModelKind::kKitten: return "kitten";
    case sherpaonnx::TtsModelKind::kPocket: return "pocket";
    case sherpaonnx::TtsModelKind::kZipvoice: return "zipvoice";
    default: return "unknown";
  }
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTestSherpaInit(JNIEnv* env, jobject /* this */) {
  return env->NewStringUTF("sherpa-onnx native (libsherpaonnx) loaded");
}

// Check if QNN HTP backend can actually be initialized (QnnBackend_create + free).
// Uses dlopen/dlsym so we do not need to link against QNN SDK at build time.
JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeCanInitQnnHtp(JNIEnv* /* env */, jobject /* this */) {
#if !defined(__ANDROID__)
  return JNI_FALSE;
#else
  static const char* QNN_LOG_TAG = "SherpaOnnx";
  void* handle = dlopen("libQnnHtp.so", RTLD_NOW | RTLD_LOCAL);
  if (!handle) {
    __android_log_print(ANDROID_LOG_INFO, QNN_LOG_TAG, "QNN: dlopen(libQnnHtp.so) failed: %s", dlerror());
    return JNI_FALSE;
  }
  using CreateFn = int (*)(const char*, const void*, void**);
  using FreeFn = int (*)(void*);
  auto create = reinterpret_cast<CreateFn>(dlsym(handle, "QnnBackend_create"));
  auto free_fn = reinterpret_cast<FreeFn>(dlsym(handle, "QnnBackend_free"));
  if (!create || !free_fn) {
    __android_log_print(ANDROID_LOG_INFO, QNN_LOG_TAG, "QNN: dlsym failed: %s", dlerror());
    dlclose(handle);
    return JNI_FALSE;
  }
  void* backend = nullptr;
  const int err = create("QnnHtp", nullptr, &backend);
  __android_log_print(ANDROID_LOG_INFO, QNN_LOG_TAG, "QNN: QnnBackend_create err=%d backend=%p", err, (void*)backend);
  if (err == 0 && backend) {
    free_fn(backend);
  }
  dlclose(handle);
  jboolean ok = (err == 0 && backend) ? JNI_TRUE : JNI_FALSE;
  __android_log_print(ANDROID_LOG_INFO, QNN_LOG_TAG, "QNN: canInit=%s", ok ? "true" : "false");
  return ok;
#endif
}

// NNAPI device enumeration via dlopen so it works regardless of compile-time minSdk (API 29+ at runtime).
#if defined(__ANDROID__)
namespace {
constexpr int ANEURALNETWORKS_NO_ERROR = 0;
constexpr int32_t ANEURALNETWORKS_DEVICE_GPU = 3;
constexpr int32_t ANEURALNETWORKS_DEVICE_ACCELERATOR = 4;
struct ANeuralNetworksDeviceOpaque {};
using ANeuralNetworksDevice = ANeuralNetworksDeviceOpaque*;
}  // namespace
#endif

// Check if the device has an NNAPI accelerator (GPU/DSP/NPU). Requires Android API 29+ at runtime.
// Loads NNAPI from libandroid.so via dlopen so it works even when the app is built with minSdk < 29.
JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeHasNnapiAccelerator(JNIEnv* /* env */, jobject /* this */, jint sdkInt) {
#if !defined(__ANDROID__)
  return JNI_FALSE;
#else
  __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG,
                     "NNAPI hasAccelerator: called (runtime SDK=%d)", sdkInt);
  if (sdkInt < 29) {
    __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG, "NNAPI: SDK %d < 29, returning false", sdkInt);
    return JNI_FALSE;
  }
  // NNAPI symbols can be in libneuralnetworks.so (runtime) or libandroid.so; try both.
  const char* libs[] = {"libneuralnetworks.so", "libandroid.so"};
  void* lib = nullptr;
  for (const char* libName : libs) {
    lib = dlopen(libName, RTLD_NOW);
    if (lib) break;
    __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG, "NNAPI: dlopen(%s) failed: %s", libName, dlerror());
  }
  if (!lib) {
    return JNI_FALSE;
  }
  using GetDeviceCountFn = int (*)(uint32_t*);
  using GetDeviceFn = int (*)(uint32_t, ANeuralNetworksDevice*);  // out param: ANeuralNetworksDevice*
  using GetTypeFn = int (*)(ANeuralNetworksDevice, int32_t*);
  auto getDeviceCount = reinterpret_cast<GetDeviceCountFn>(dlsym(lib, "ANeuralNetworks_getDeviceCount"));
  auto getDevice = reinterpret_cast<GetDeviceFn>(dlsym(lib, "ANeuralNetworks_getDevice"));
  auto getType = reinterpret_cast<GetTypeFn>(dlsym(lib, "ANeuralNetworksDevice_getType"));
  if (!getDeviceCount || !getDevice || !getType) {
    __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG, "NNAPI: dlsym failed (getCount=%p getDevice=%p getType=%p): %s",
                       (void*)getDeviceCount, (void*)getDevice, (void*)getType, dlerror());
    dlclose(lib);
    return JNI_FALSE;
  }
  uint32_t numDevices = 0;
  int err = getDeviceCount(&numDevices);
  __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG, "NNAPI getDeviceCount: err=%d numDevices=%u", err, numDevices);
  if (err != ANEURALNETWORKS_NO_ERROR || numDevices == 0) {
    dlclose(lib);
    return JNI_FALSE;
  }
  jboolean hasAccelerator = JNI_FALSE;
  for (uint32_t i = 0; i < numDevices; ++i) {
    ANeuralNetworksDevice device = nullptr;
    err = getDevice(i, &device);
    if (err != ANEURALNETWORKS_NO_ERROR || !device) {
      __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG,
                         "NNAPI device[%u] getDevice: err=%d device=%p", i, err, (void*)device);
      continue;
    }
    int32_t type = 0;
    int typeErr = getType(device, &type);
    __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG,
                       "NNAPI device[%u] getType: err=%d type=%d (1=OTHER 2=CPU 3=GPU 4=ACCELERATOR)", i, typeErr, type);
    if (typeErr == ANEURALNETWORKS_NO_ERROR &&
        (type == ANEURALNETWORKS_DEVICE_ACCELERATOR || type == ANEURALNETWORKS_DEVICE_GPU)) {
      hasAccelerator = JNI_TRUE;
    }
  }
  __android_log_print(ANDROID_LOG_INFO, NNAPI_LOG_TAG, "NNAPI hasAccelerator result=%s", hasAccelerator ? "true" : "false");
  dlclose(lib);
  return hasAccelerator;
#endif
}

// Detect STT model in directory. Returns HashMap with success, error, detectedModels, modelType, paths.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectSttModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jboolean j_prefer_int8,
    jboolean j_has_prefer_int8,
    jstring j_model_type,
    jboolean j_debug) {
  const char* model_dir_c = env->GetStringUTFChars(j_model_dir, nullptr);
  const char* model_type_c = j_model_type ? env->GetStringUTFChars(j_model_type, nullptr) : nullptr;
  std::string model_dir(model_dir_c ? model_dir_c : "");
  std::optional<bool> prefer_int8;
  if (j_has_prefer_int8) prefer_int8 = (j_prefer_int8 == JNI_TRUE);
  std::optional<std::string> model_type_opt;
  if (model_type_c && model_type_c[0] != '\0') model_type_opt = std::string(model_type_c);
  env->ReleaseStringUTFChars(j_model_dir, model_dir_c);
  if (model_type_c) env->ReleaseStringUTFChars(j_model_type, model_type_c);

  sherpaonnx::SttDetectResult result = sherpaonnx::DetectSttModel(
      model_dir, prefer_int8, model_type_opt, (j_debug == JNI_TRUE));

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

  putBoolean(env, map, mapPut, "success", result.ok);
  putString(env, map, mapPut, "error", result.error);
  putString(env, map, mapPut, "modelType", sttModelKindToString(result.selectedKind));

  jobject detectedList = buildDetectedModelsList(env, result.detectedModels);
  if (detectedList) {
    env->CallObjectMethod(map, mapPut, env->NewStringUTF("detectedModels"), detectedList);
    env->DeleteLocalRef(detectedList);
  }

  jclass hashMapClass = env->FindClass("java/util/HashMap");
  if (hashMapClass) {
    jobject pathsMap = env->NewObject(hashMapClass, mapInit);
    env->DeleteLocalRef(hashMapClass);
    if (pathsMap) {
      putString(env, pathsMap, mapPut, "encoder", result.paths.encoder);
      putString(env, pathsMap, mapPut, "decoder", result.paths.decoder);
      putString(env, pathsMap, mapPut, "joiner", result.paths.joiner);
      putString(env, pathsMap, mapPut, "tokens", result.paths.tokens);
      putString(env, pathsMap, mapPut, "paraformerModel", result.paths.paraformerModel);
      putString(env, pathsMap, mapPut, "ctcModel", result.paths.ctcModel);
      putString(env, pathsMap, mapPut, "whisperEncoder", result.paths.whisperEncoder);
      putString(env, pathsMap, mapPut, "whisperDecoder", result.paths.whisperDecoder);
      putString(env, pathsMap, mapPut, "funasrEncoderAdaptor", result.paths.funasrEncoderAdaptor);
      putString(env, pathsMap, mapPut, "funasrLLM", result.paths.funasrLLM);
      putString(env, pathsMap, mapPut, "funasrEmbedding", result.paths.funasrEmbedding);
      putString(env, pathsMap, mapPut, "funasrTokenizer", result.paths.funasrTokenizer);
      putString(env, pathsMap, mapPut, "moonshinePreprocessor", result.paths.moonshinePreprocessor);
      putString(env, pathsMap, mapPut, "moonshineEncoder", result.paths.moonshineEncoder);
      putString(env, pathsMap, mapPut, "moonshineUncachedDecoder", result.paths.moonshineUncachedDecoder);
      putString(env, pathsMap, mapPut, "moonshineCachedDecoder", result.paths.moonshineCachedDecoder);
      putString(env, pathsMap, mapPut, "dolphinModel", result.paths.dolphinModel);
      putString(env, pathsMap, mapPut, "omnilingualModel", result.paths.omnilingualModel);
      putString(env, pathsMap, mapPut, "medasrModel", result.paths.medasrModel);
      putString(env, pathsMap, mapPut, "telespeechCtcModel", result.paths.telespeechCtcModel);
      putString(env, pathsMap, mapPut, "fireRedEncoder", result.paths.fireRedEncoder);
      putString(env, pathsMap, mapPut, "fireRedDecoder", result.paths.fireRedDecoder);
      putString(env, pathsMap, mapPut, "canaryEncoder", result.paths.canaryEncoder);
      putString(env, pathsMap, mapPut, "canaryDecoder", result.paths.canaryDecoder);
      putString(env, pathsMap, mapPut, "bpeVocab", result.paths.bpeVocab);
      env->CallObjectMethod(map, mapPut, env->NewStringUTF("paths"), pathsMap);
      env->DeleteLocalRef(pathsMap);
    }
  }
  return map;
}

// Detect TTS model in directory. Returns HashMap with success, error, detectedModels, modelType, paths.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectTtsModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_model_type) {
  const char* model_dir_c = env->GetStringUTFChars(j_model_dir, nullptr);
  const char* model_type_c = j_model_type ? env->GetStringUTFChars(j_model_type, nullptr) : nullptr;
  std::string model_dir(model_dir_c ? model_dir_c : "");
  std::string model_type(model_type_c ? model_type_c : "auto");
  env->ReleaseStringUTFChars(j_model_dir, model_dir_c);
  if (model_type_c) env->ReleaseStringUTFChars(j_model_type, model_type_c);

  sherpaonnx::TtsDetectResult result = sherpaonnx::DetectTtsModel(model_dir, model_type);

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

  putBoolean(env, map, mapPut, "success", result.ok);
  putString(env, map, mapPut, "error", result.error);
  putString(env, map, mapPut, "modelType", ttsModelKindToString(result.selectedKind));

  jobject detectedList = buildDetectedModelsList(env, result.detectedModels);
  if (detectedList) {
    env->CallObjectMethod(map, mapPut, env->NewStringUTF("detectedModels"), detectedList);
    env->DeleteLocalRef(detectedList);
  }

  jclass hashMapClass = env->FindClass("java/util/HashMap");
  if (hashMapClass) {
    jobject pathsMap = env->NewObject(hashMapClass, mapInit);
    env->DeleteLocalRef(hashMapClass);
    if (pathsMap) {
      putString(env, pathsMap, mapPut, "ttsModel", result.paths.ttsModel);
      putString(env, pathsMap, mapPut, "tokens", result.paths.tokens);
      putString(env, pathsMap, mapPut, "lexicon", result.paths.lexicon);
      putString(env, pathsMap, mapPut, "dataDir", result.paths.dataDir);
      putString(env, pathsMap, mapPut, "voices", result.paths.voices);
      putString(env, pathsMap, mapPut, "acousticModel", result.paths.acousticModel);
      putString(env, pathsMap, mapPut, "vocoder", result.paths.vocoder);
      putString(env, pathsMap, mapPut, "encoder", result.paths.encoder);
      putString(env, pathsMap, mapPut, "decoder", result.paths.decoder);
      putString(env, pathsMap, mapPut, "lmFlow", result.paths.lmFlow);
      putString(env, pathsMap, mapPut, "lmMain", result.paths.lmMain);
      putString(env, pathsMap, mapPut, "textConditioner", result.paths.textConditioner);
      putString(env, pathsMap, mapPut, "vocabJson", result.paths.vocabJson);
      putString(env, pathsMap, mapPut, "tokenScoresJson", result.paths.tokenScoresJson);
      env->CallObjectMethod(map, mapPut, env->NewStringUTF("paths"), pathsMap);
      env->DeleteLocalRef(pathsMap);
    }
  }
  return map;
}

}  // extern "C"
