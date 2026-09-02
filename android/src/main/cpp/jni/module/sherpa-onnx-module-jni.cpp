/**
 * sherpa-onnx-module-jni.cpp
 *
 * Purpose: JNI entry points for SherpaOnnxModule: nativeTestSherpaInit, nativeCanInitQnnHtp,
 * nativeHasNnapiAccelerator, nativeDetectSttModel, nativeDetectTtsModel.
 * Used by Kotlin to probe
 * capabilities and get model paths for the Kotlin STT/TTS API.
 */
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
#include "sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-tts-wrapper.h"
#include "sherpa-onnx-enhancement-wrapper.h"
#include "sherpa-onnx-separation-detect-wrapper.h"
#include "sherpa-onnx-speaker-embedding-detect-wrapper.h"
#include "sherpa-onnx-punctuation-wrapper.h"
#include "sherpa-onnx-vad-wrapper.h"
#include "sherpa-onnx-alignment-wrapper.h"
#include "sherpa-onnx-model-detect-unified.h"
#include "sherpa-onnx-unified-detect-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "sherpa-onnx-validate-custom.h"
#include "../diagnostic/NativeDiagnostic.h"

namespace {

std::optional<std::string> OptionalJstring(JNIEnv* env, jstring value) {
  if (!value) return std::nullopt;
  const char* c = env->GetStringUTFChars(value, nullptr);
  if (!c) {
    return std::nullopt;
  }
  if (c[0] == '\0') {
    env->ReleaseStringUTFChars(value, c);
    return std::nullopt;
  }
  std::string out(c);
  env->ReleaseStringUTFChars(value, c);
  return out;
}

bool CopyOptionalJstring(
    JNIEnv* env,
    jstring value,
    std::optional<std::string>& out) {
  if (!value) {
    return true;
  }
  const char* c = env->GetStringUTFChars(value, nullptr);
  if (!c) {
    return false;
  }
  if (c[0] != '\0') {
    out = std::string(c);
  }
  env->ReleaseStringUTFChars(value, c);
  return true;
}

bool CopyModelTypeJstring(JNIEnv* env, jstring value, std::string& out) {
  if (!value) {
    out = "auto";
    return true;
  }
  const char* c = env->GetStringUTFChars(value, nullptr);
  if (!c) {
    return false;
  }
  out = c;
  env->ReleaseStringUTFChars(value, c);
  return true;
}

bool CopyRequiredJstring(JNIEnv* env, jstring value, std::string& out) {
  if (!value) {
    out.clear();
    return true;
  }
  const char* c = env->GetStringUTFChars(value, nullptr);
  if (!c) {
    return false;
  }
  out = c;
  env->ReleaseStringUTFChars(value, c);
  return true;
}

std::optional<std::string> HashMapGetString(
    JNIEnv* env,
    jobject map,
    jmethodID get,
    const char* key) {
  jstring jkey = env->NewStringUTF(key);
  if (!jkey) return std::nullopt;
  jobject jval = env->CallObjectMethod(map, get, jkey);
  env->DeleteLocalRef(jkey);
  if (!jval) return std::nullopt;
  auto str = OptionalJstring(env, static_cast<jstring>(jval));
  env->DeleteLocalRef(jval);
  return str;
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTestSherpaInit(JNIEnv* env, jobject /* this */) {
  SHERPA_DIAG("module.init", "libs_loaded");
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
// Must match enum values in Android NDK NeuralNetworks.h: 
// https://android.googlesource.com/platform/frameworks/ml/+/refs/heads/master/nn/runtime/include/NeuralNetworks.h
// UNKNOWN= 0, OTHER = 1, CPU = 2, GPU = 3, ACCELERATOR = 4.
constexpr int32_t ANEURALNETWORKS_DEVICE_GPU = 3;
constexpr int32_t ANEURALNETWORKS_DEVICE_ACCELERATOR = 4;
struct ANeuralNetworksDeviceOpaque;
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

// Detect STT model from optional directory and/or asset name. Returns HashMap with unified detect fields.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectSttModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type,
    jboolean j_prefer_int8,
    jboolean j_has_prefer_int8,
    jboolean j_debug) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }
  std::optional<bool> prefer_int8;
  if (j_has_prefer_int8) prefer_int8 = (j_prefer_int8 == JNI_TRUE);

  SHERPA_DIAG("stt.detect", "start");
  sherpaonnx::SttDetectResult result = sherpaonnx::DetectSttModel(
      model_dir,
      asset_name,
      model_type,
      prefer_int8,
      (j_debug == JNI_TRUE));
  SHERPA_DIAG("stt.detect", "end");
  return sherpaonnx::SttDetectResultToJava(env, result);
}

// Detect TTS model: optional directory path and/or asset name (release id stem). Returns HashMap.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectTtsModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::TtsDetectResult result = sherpaonnx::DetectTtsModel(model_dir, asset_name, model_type);
  return sherpaonnx::TtsDetectResultToJava(env, result);
}

// Detect enhancement model from optional directory and/or asset name. Returns HashMap with unified detect fields.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectEnhancementModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::EnhancementDetectResult result =
      sherpaonnx::DetectEnhancementModel(model_dir, asset_name, model_type);
  return sherpaonnx::EnhancementDetectResultToJava(env, result);
}

// Source separation: Spleeter (vocals+accompaniment) or UVR (single ONNX). Offline only.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectSeparationModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::SeparationDetectResult result =
      sherpaonnx::DetectSeparationModel(model_dir, asset_name, model_type);
  return sherpaonnx::SeparationDetectResultToJava(env, result);
}

// Speaker embedding: wespeaker / 3d-speaker / nemo (offline only).
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectSpeakerEmbeddingModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::SpeakerEmbeddingDetectResult result =
      sherpaonnx::DetectSpeakerEmbeddingModel(model_dir, asset_name, model_type);
  return sherpaonnx::SpeakerEmbeddingDetectResultToJava(env, result);
}

// Punctuation: CT-transformer (offline) or CNN-BiLSTM (online) layout. Returns HashMap with detect fields.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectPunctuationModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::PunctuationDetectResult result =
      sherpaonnx::DetectPunctuationModel(model_dir, asset_name, model_type);
  return sherpaonnx::PunctuationDetectResultToJava(env, result);
}

// Detect VAD model from optional directory and/or asset name. Returns HashMap with unified detect fields.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectVadModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name,
    jstring j_model_type) {
  std::optional<std::string> model_dir;
  std::optional<std::string> asset_name;
  std::string model_type;
  if (!CopyOptionalJstring(env, j_model_dir, model_dir) ||
      !CopyOptionalJstring(env, j_asset_name, asset_name) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::VadDetectResult result =
      sherpaonnx::DetectVadModel(model_dir, asset_name, model_type);
  return sherpaonnx::VadDetectResultToJava(env, result);
}

// Detect alignment model in directory. Returns HashMap with success, error, detectedModels, modelType, paths.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectAlignmentModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_model_type) {
  std::string model_dir;
  std::string model_type;
  if (!CopyRequiredJstring(env, j_model_dir, model_dir) ||
      !CopyModelTypeJstring(env, j_model_type, model_type)) {
    return nullptr;
  }

  sherpaonnx::AlignmentDetectResult result =
      sherpaonnx::DetectAlignmentModel(model_dir, model_type);
  return sherpaonnx::AlignmentDetectResultToJava(env, result);
}

}  // extern "C"

extern "C" {

// Unified model detection (TTS→STT→VAD→Punctuation→Enhancement→Separation→Alignment). Returns HashMap.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectModel(
    JNIEnv* env,
    jobject /* this */,
    jstring j_model_dir,
    jstring j_asset_name) {
  auto model_dir = OptionalJstring(env, j_model_dir);
  auto asset_name = OptionalJstring(env, j_asset_name);
  sherpaonnx::UnifiedModelDetectResult result =
      sherpaonnx::DetectModel(model_dir, asset_name);
  return sherpaonnx::UnifiedDetectResultToJava(env, result);
}

// Batch unified detection. Input: ArrayList<HashMap> with modelDir/assetName keys.
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDetectModelsBatch(
    JNIEnv* env,
    jobject /* this */,
    jobject j_inputs) {
  if (!j_inputs) {
    jclass listClass = env->FindClass("java/util/ArrayList");
    if (!listClass) return nullptr;
    jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
    jobject empty = listInit ? env->NewObject(listClass, listInit) : nullptr;
    env->DeleteLocalRef(listClass);
    return empty;
  }

  jclass listClass = env->FindClass("java/util/ArrayList");
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!listClass || !mapClass) return nullptr;
  jmethodID listSize = env->GetMethodID(listClass, "size", "()I");
  jmethodID listGet = env->GetMethodID(listClass, "get", "(I)Ljava/lang/Object;");
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "()V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");
  jmethodID mapGet = env->GetMethodID(
      mapClass,
      "get",
      "(Ljava/lang/Object;)Ljava/lang/Object;");
  if (!listSize || !listGet || !listInit || !listAdd || !mapGet) {
    env->DeleteLocalRef(listClass);
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }

  const jint count = env->CallIntMethod(j_inputs, listSize);
  std::vector<sherpaonnx::UnifiedModelDetectInput> inputs;
  inputs.reserve(static_cast<size_t>(count > 0 ? count : 0));
  for (jint i = 0; i < count; ++i) {
    jobject entry = env->CallObjectMethod(j_inputs, listGet, i);
    if (!entry) continue;
    sherpaonnx::UnifiedModelDetectInput input;
    input.model_dir = HashMapGetString(env, entry, mapGet, "modelDir");
    input.asset_name = HashMapGetString(env, entry, mapGet, "assetName");
    inputs.push_back(std::move(input));
    env->DeleteLocalRef(entry);
  }

  std::vector<sherpaonnx::UnifiedModelDetectResult> results =
      sherpaonnx::DetectModelsBatch(inputs);

  jobject outList = env->NewObject(listClass, listInit);
  env->DeleteLocalRef(listClass);
  env->DeleteLocalRef(mapClass);
  if (!outList) return nullptr;

  for (const auto& result : results) {
    jobject map = sherpaonnx::UnifiedDetectResultToJava(env, result);
    if (map) {
      env->CallBooleanMethod(outList, listAdd, map);
      env->DeleteLocalRef(map);
    }
  }
  return outList;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeValidateCustomModelPaths(
    JNIEnv* env,
    jobject /* this */,
    jstring j_category,
    jstring j_model_type,
    jobject j_paths) {
  auto category = OptionalJstring(env, j_category);
  auto modelType = OptionalJstring(env, j_model_type);
  if (!category || !modelType) {
    sherpaonnx::CustomModelValidationResult invalid;
    invalid.ok = false;
    invalid.error = "category and modelType are required";
    return sherpaonnx::BuildCustomValidationResultMap(env, invalid);
  }

  const auto paths = sherpaonnx::JavaHashMapToStringMap(env, j_paths);
  const auto result = sherpaonnx::ValidateCustomModelPaths(
      *category,
      *modelType,
      paths,
      "custom");
  return sherpaonnx::BuildCustomValidationResultMap(env, result);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeGetCustomModelPathRequirements(
    JNIEnv* env,
    jobject /* this */,
    jstring j_category,
    jstring j_model_type) {
  auto category = OptionalJstring(env, j_category);
  auto modelType = OptionalJstring(env, j_model_type);
  if (!category || !modelType) {
    return sherpaonnx::BuildCustomPathRequirementsMap(env, {});
  }

  const auto requirements = sherpaonnx::GetCustomModelPathRequirements(
      *category,
      *modelType);
  return sherpaonnx::BuildCustomPathRequirementsMap(env, requirements);
}

}  // extern "C"
