#include "SherpaOnnxJSI.h"

#include "../audio/AudioVisualization.h"

#include <cstring>
#include <memory>
#include <string>
#include <vector>

using namespace facebook;

namespace {

JavaVM *g_jvm = nullptr;
jobject g_registry_ref = nullptr;

jmethodID g_get_offline_samples_method = nullptr;
jmethodID g_get_live_samples_method = nullptr;
jmethodID g_create_offline_from_array_method = nullptr;
jmethodID g_append_samples_to_live_method = nullptr;

bool hasJNIReferences() {
  return g_jvm != nullptr && g_registry_ref != nullptr &&
         g_get_offline_samples_method != nullptr &&
         g_get_live_samples_method != nullptr &&
         g_create_offline_from_array_method != nullptr &&
         g_append_samples_to_live_method != nullptr;
}

JNIEnv *getJNIEnv() {
  if (g_jvm == nullptr) {
    return nullptr;
  }

  JNIEnv *env = nullptr;
  const jint get_env_result =
      g_jvm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (get_env_result == JNI_EDETACHED) {
#if defined(__ANDROID__) || defined(ANDROID)
    if (g_jvm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
      return nullptr;
    }
#else
    if (g_jvm->AttachCurrentThread(reinterpret_cast<void **>(&env), nullptr) !=
        JNI_OK) {
      return nullptr;
    }
#endif
  } else if (get_env_result != JNI_OK) {
    return nullptr;
  }

  return env;
}

std::string getAndClearJavaExceptionMessage(JNIEnv *env) {
  if (!env->ExceptionCheck()) {
    return "Unknown JNI error";
  }

  jthrowable throwable = env->ExceptionOccurred();
  env->ExceptionClear();

  std::string message = "Java exception";
  if (throwable != nullptr) {
    jclass throwable_class = env->GetObjectClass(throwable);
    if (throwable_class != nullptr) {
      const jmethodID to_string =
          env->GetMethodID(throwable_class, "toString", "()Ljava/lang/String;");
      if (to_string != nullptr) {
        auto msg_obj = static_cast<jstring>(env->CallObjectMethod(throwable, to_string));
        if (msg_obj != nullptr) {
          const char *msg_chars = env->GetStringUTFChars(msg_obj, nullptr);
          if (msg_chars != nullptr) {
            message = msg_chars;
            env->ReleaseStringUTFChars(msg_obj, msg_chars);
          }
          env->DeleteLocalRef(msg_obj);
        }
      }
      env->DeleteLocalRef(throwable_class);
    }
    env->DeleteLocalRef(throwable);
  }

  return message;
}

std::string requireStringArg(jsi::Runtime &rt, const jsi::Value *args,
                             size_t index, const char *name) {
  if (!args[index].isString()) {
    throw jsi::JSError(rt,
                       std::string("[INVALID_ARGS] Expected string for ") + name);
  }
  return args[index].asString(rt).utf8(rt);
}

int requireIntArg(jsi::Runtime &rt, const jsi::Value *args, size_t index,
                  const char *name) {
  if (!args[index].isNumber()) {
    throw jsi::JSError(rt,
                       std::string("[INVALID_ARGS] Expected number for ") + name);
  }
  return static_cast<int>(args[index].asNumber());
}

jsi::ArrayBuffer requireArrayBufferArg(jsi::Runtime &rt, const jsi::Value *args,
                                       size_t index, const char *name) {
  if (!args[index].isObject()) {
    throw jsi::JSError(
        rt, std::string("[INVALID_ARGS] Expected ArrayBuffer for ") + name);
  }

  auto obj = args[index].asObject(rt);
  if (!obj.isArrayBuffer(rt)) {
    throw jsi::JSError(
        rt, std::string("[INVALID_ARGS] Expected ArrayBuffer for ") + name);
  }

  return obj.getArrayBuffer(rt);
}

std::shared_ptr<sherpa::OwnedBuffer> copyFloatArrayToOwnedBuffer(JNIEnv *env,
                                                                  jfloatArray src) {
  jsize len = env->GetArrayLength(src);
  auto buffer = std::make_shared<sherpa::OwnedBuffer>(
      static_cast<size_t>(len) * sizeof(float));
  if (len <= 0) {
    return buffer;
  }

  std::vector<jfloat> tmp(static_cast<size_t>(len));
  env->GetFloatArrayRegion(src, 0, len, tmp.data());
  std::memcpy(buffer->data(), tmp.data(), static_cast<size_t>(len) * sizeof(float));
  return buffer;
}

jfloatArray copyArrayBufferToJFloatArray(jsi::Runtime &rt, JNIEnv *env,
                                         const jsi::ArrayBuffer &array_buffer) {
  const size_t byte_len = array_buffer.size(rt);
  if ((byte_len % sizeof(float)) != 0) {
    throw jsi::JSError(
        rt,
        "[INVALID_ARGS] ArrayBuffer byte length must be a multiple of 4 bytes");
  }

  const jsize sample_count = static_cast<jsize>(byte_len / sizeof(float));
  jfloatArray out = env->NewFloatArray(sample_count);
  if (out == nullptr) {
    throw jsi::JSError(rt, "[INTERNAL_ERROR] Failed to allocate float array");
  }

  if (sample_count > 0) {
    std::vector<jfloat> tmp(static_cast<size_t>(sample_count));
    std::memcpy(tmp.data(), array_buffer.data(rt), byte_len);
    env->SetFloatArrayRegion(out, 0, sample_count, tmp.data());
  }

  return out;
}

jsi::Value jsiGetOfflineSamples(jsi::Runtime &rt, const jsi::Value &,
                                const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(
        rt, "[INVALID_ARGS] getOfflineBufferSamples requires 3 arguments");
  }

  if (!hasJNIReferences()) {
    throw jsi::JSError(rt,
                       "[JSI_NOT_INSTALLED] JNI references are not initialized");
  }

  const std::string buffer_id = requireStringArg(rt, args, 0, "bufferId");
  const int start_frame = requireIntArg(rt, args, 1, "startFrame");
  const int frame_count = requireIntArg(rt, args, 2, "frameCount");

  JNIEnv *env = getJNIEnv();
  if (env == nullptr) {
    throw jsi::JSError(rt, "[INTERNAL_ERROR] Failed to access JNI environment");
  }

  jstring j_buffer_id = env->NewStringUTF(buffer_id.c_str());
  auto result = static_cast<jfloatArray>(env->CallObjectMethod(
      g_registry_ref, g_get_offline_samples_method, j_buffer_id, start_frame,
      frame_count));
  env->DeleteLocalRef(j_buffer_id);

  if (env->ExceptionCheck()) {
    throw jsi::JSError(rt, getAndClearJavaExceptionMessage(env));
  }

  if (result == nullptr) {
    auto empty = std::make_shared<sherpa::OwnedBuffer>(0);
    return jsi::ArrayBuffer(rt, std::move(empty));
  }

  auto buffer = copyFloatArrayToOwnedBuffer(env, result);
  env->DeleteLocalRef(result);

  if (env->ExceptionCheck()) {
    throw jsi::JSError(rt, getAndClearJavaExceptionMessage(env));
  }

  return jsi::ArrayBuffer(rt, std::move(buffer));
}

jsi::Value jsiGetLiveSamples(jsi::Runtime &rt, const jsi::Value &,
                             const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(rt,
                       "[INVALID_ARGS] getLiveBufferSamples requires 3 arguments");
  }

  if (!hasJNIReferences()) {
    throw jsi::JSError(rt,
                       "[JSI_NOT_INSTALLED] JNI references are not initialized");
  }

  const std::string buffer_id = requireStringArg(rt, args, 0, "bufferId");
  const int start_frame = requireIntArg(rt, args, 1, "startFrame");
  const int frame_count = requireIntArg(rt, args, 2, "frameCount");

  JNIEnv *env = getJNIEnv();
  if (env == nullptr) {
    throw jsi::JSError(rt, "[INTERNAL_ERROR] Failed to access JNI environment");
  }

  jstring j_buffer_id = env->NewStringUTF(buffer_id.c_str());
  auto result = static_cast<jfloatArray>(env->CallObjectMethod(
      g_registry_ref, g_get_live_samples_method, j_buffer_id, start_frame,
      frame_count));
  env->DeleteLocalRef(j_buffer_id);

  if (env->ExceptionCheck()) {
    throw jsi::JSError(rt, getAndClearJavaExceptionMessage(env));
  }

  if (result == nullptr) {
    auto empty = std::make_shared<sherpa::OwnedBuffer>(0);
    return jsi::ArrayBuffer(rt, std::move(empty));
  }

  auto buffer = copyFloatArrayToOwnedBuffer(env, result);
  env->DeleteLocalRef(result);

  if (env->ExceptionCheck()) {
    throw jsi::JSError(rt, getAndClearJavaExceptionMessage(env));
  }

  return jsi::ArrayBuffer(rt, std::move(buffer));
}

jsi::Value jsiCreateOfflineFromSamples(jsi::Runtime &rt, const jsi::Value &,
                                       const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(
        rt, "[INVALID_ARGS] createOfflineFromSamples requires 3 arguments");
  }

  if (!hasJNIReferences()) {
    throw jsi::JSError(rt,
                       "[JSI_NOT_INSTALLED] JNI references are not initialized");
  }

  const auto samples_buffer =
      requireArrayBufferArg(rt, args, 0, "samples ArrayBuffer");
  const int sample_rate = requireIntArg(rt, args, 1, "sampleRate");
  const int channel_count = requireIntArg(rt, args, 2, "channelCount");

  JNIEnv *env = getJNIEnv();
  if (env == nullptr) {
    throw jsi::JSError(rt, "[INTERNAL_ERROR] Failed to access JNI environment");
  }

  jfloatArray j_samples = copyArrayBufferToJFloatArray(rt, env, samples_buffer);
  auto result = static_cast<jstring>(env->CallObjectMethod(
      g_registry_ref, g_create_offline_from_array_method, j_samples, sample_rate,
      channel_count));
  env->DeleteLocalRef(j_samples);

  if (env->ExceptionCheck()) {
    throw jsi::JSError(rt, getAndClearJavaExceptionMessage(env));
  }

  if (result == nullptr) {
    throw jsi::JSError(rt,
                       "[INTERNAL_ERROR] createOfflineFromSamples returned null");
  }

  const char *chars = env->GetStringUTFChars(result, nullptr);
  std::string json = chars ? chars : "";
  if (chars != nullptr) {
    env->ReleaseStringUTFChars(result, chars);
  }
  env->DeleteLocalRef(result);

  return jsi::String::createFromUtf8(rt, json);
}

jsi::Value jsiAppendSamplesToLive(jsi::Runtime &rt, const jsi::Value &,
                                  const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(rt,
                       "[INVALID_ARGS] appendSamplesToLive requires 3 arguments");
  }

  if (!hasJNIReferences()) {
    throw jsi::JSError(rt,
                       "[JSI_NOT_INSTALLED] JNI references are not initialized");
  }

  const std::string buffer_id = requireStringArg(rt, args, 0, "liveBufferId");
  const auto samples_buffer =
      requireArrayBufferArg(rt, args, 1, "samples ArrayBuffer");
  const int sample_rate = requireIntArg(rt, args, 2, "sampleRate");

  JNIEnv *env = getJNIEnv();
  if (env == nullptr) {
    throw jsi::JSError(rt, "[INTERNAL_ERROR] Failed to access JNI environment");
  }

  jstring j_buffer_id = env->NewStringUTF(buffer_id.c_str());
  jfloatArray j_samples = copyArrayBufferToJFloatArray(rt, env, samples_buffer);

  env->CallVoidMethod(g_registry_ref, g_append_samples_to_live_method,
                      j_buffer_id, j_samples, sample_rate);
  env->DeleteLocalRef(j_buffer_id);
  env->DeleteLocalRef(j_samples);

  if (env->ExceptionCheck()) {
    throw jsi::JSError(rt, getAndClearJavaExceptionMessage(env));
  }

  return jsi::Value::undefined();
}

jsi::Value jsiTakeVisualizationFrames(jsi::Runtime &rt, const jsi::Value &,
                                      const jsi::Value *args, size_t count) {
  if (count < 1) {
    throw jsi::JSError(
        rt, "[INVALID_ARGS] takeVisualizationFrames requires 1 argument");
  }

  const std::string transfer_id = requireStringArg(rt, args, 0, "transferId");

  std::vector<float> frames;
  if (!sherpa::takeVisualizationFramesTransfer(transfer_id, &frames)) {
    throw jsi::JSError(
        rt,
        "[AUDIO_VISUALIZATION_TRANSFER_NOT_FOUND] Visualization frame transfer not found or already consumed");
  }

  auto out =
      std::make_shared<sherpa::OwnedBuffer>(frames.size() * sizeof(float));
  if (!frames.empty()) {
    std::memcpy(out->data(), frames.data(), frames.size() * sizeof(float));
  }
  return jsi::ArrayBuffer(rt, std::move(out));
}

}  // namespace

namespace sherpa {

bool cacheJNIReferences(JNIEnv *env, jobject registry) {
  if (env == nullptr || registry == nullptr) {
    return false;
  }

  if (env->GetJavaVM(&g_jvm) != JNI_OK) {
    return false;
  }

  if (g_registry_ref != nullptr) {
    env->DeleteGlobalRef(g_registry_ref);
    g_registry_ref = nullptr;
  }
  g_registry_ref = env->NewGlobalRef(registry);
  if (g_registry_ref == nullptr) {
    return false;
  }

  jclass registry_class = env->GetObjectClass(registry);
  if (registry_class == nullptr) {
    if (env->ExceptionCheck()) {
      env->ExceptionClear();
    }
    return false;
  }

  g_get_offline_samples_method = env->GetMethodID(
      registry_class, "getOfflineSamplesSliceJni", "(Ljava/lang/String;II)[F");
  g_get_live_samples_method = env->GetMethodID(
      registry_class, "getLiveSamplesSliceJni", "(Ljava/lang/String;II)[F");
  g_create_offline_from_array_method = env->GetMethodID(
      registry_class, "createOfflineFromFloatArrayJni", "([FII)Ljava/lang/String;");
  g_append_samples_to_live_method = env->GetMethodID(
      registry_class, "appendSamplesToLiveJni", "(Ljava/lang/String;[FI)V");

  env->DeleteLocalRef(registry_class);

  if (env->ExceptionCheck()) {
    env->ExceptionClear();
  }

  return hasJNIReferences();
}

void installJSIBindings(jsi::Runtime &rt) {
  auto obj = jsi::Object(rt);

  obj.setProperty(
      rt, "getOfflineBufferSamples",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "getOfflineBufferSamples"), 3,
          jsiGetOfflineSamples));

  obj.setProperty(
      rt, "createOfflineFromSamples",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "createOfflineFromSamples"), 3,
          jsiCreateOfflineFromSamples));

  obj.setProperty(
      rt, "getLiveBufferSamples",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "getLiveBufferSamples"), 3,
          jsiGetLiveSamples));

  obj.setProperty(
      rt, "appendSamplesToLive",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "appendSamplesToLive"), 3,
          jsiAppendSamplesToLive));

  obj.setProperty(
      rt, "takeVisualizationFrames",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "takeVisualizationFrames"), 1,
          jsiTakeVisualizationFrames));

  rt.global().setProperty(rt, "__SherpaOnnxJSI", std::move(obj));
}

}  // namespace sherpa
