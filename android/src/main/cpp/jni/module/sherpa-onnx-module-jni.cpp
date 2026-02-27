/**
 * sherpa-onnx-module-jni.cpp
 *
 * Purpose: JNI entry points for SherpaOnnxModule: nativeTestSherpaInit, nativeCanInitQnnHtp,
 * nativeHasNnapiAccelerator, nativeDetectSttModel, nativeDetectTtsModel. Used by Kotlin to probe
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
// Must match enum values in Android NDK NeuralNetworks.h: 
// https://android.googlesource.com/platform/frameworks/ml/+/refs/heads/master/nn/runtime/include/NeuralNetworks.h
// UNKNOWN= 0, OTHER = 1, CPU = 2, GPU = 3, ACCELERATOR = 4.
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
  return sherpaonnx::SttDetectResultToJava(env, result);
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
  return sherpaonnx::TtsDetectResultToJava(env, result);
}

}  // extern "C"
