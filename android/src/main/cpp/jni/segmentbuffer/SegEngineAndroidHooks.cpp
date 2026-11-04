/**
 * Strong Android overrides for seg_engine_on_* — JNI → SegmentationEngineRegistry.
 * iOS provides its own strong defs in SherpaOnnx+SegmentBuffer.mm (this TU is Android-only).
 * Host tests keep weak stubs from Audio/Text/Segment registries.
 */
#include <android/log.h>
#include <jni.h>

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>

#define SEG_ENGINE_LOG_TAG "SherpaOnnx:segengine"

namespace {

JavaVM *g_vm = nullptr;
std::mutex g_init_mutex;
jclass g_registry_class = nullptr;
jmethodID g_on_text_write = nullptr;
jmethodID g_on_audio_write = nullptr;
jmethodID g_on_finalized = nullptr;
jmethodID g_on_released = nullptr;
bool g_init_attempted = false;
bool g_init_ok = false;

JNIEnv *GetEnv(bool *attached) {
  *attached = false;
  // g_vm is set from JNI_OnLoad (archive) via seg_engine_android_hooks_onload.
  if (!g_vm) return nullptr;
  JNIEnv *env = nullptr;
  const jint got = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (got == JNI_OK) return env;
  if (got != JNI_EDETACHED) return nullptr;
  if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK || !env) return nullptr;
  *attached = true;
  return env;
}

bool EnsureMethodsLocked(JNIEnv *env) {
  if (g_init_ok) return true;
  if (g_init_attempted) return false;
  g_init_attempted = true;

  jclass local = env->FindClass("com/sherpaonnx/segment/engine/SegmentationEngineRegistry");
  if (!local) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    __android_log_print(ANDROID_LOG_ERROR, SEG_ENGINE_LOG_TAG,
                        "FindClass SegmentationEngineRegistry failed");
    return false;
  }
  g_registry_class = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  if (!g_registry_class) return false;

  g_on_text_write =
      env->GetStaticMethodID(g_registry_class, "onLiveTextWrite", "(Ljava/lang/String;)V");
  g_on_audio_write = env->GetStaticMethodID(g_registry_class, "onLiveAudioWrite",
                                            "(Ljava/lang/String;[FIJ)V");
  g_on_finalized =
      env->GetStaticMethodID(g_registry_class, "onBufferFinalized", "(Ljava/lang/String;)V");
  g_on_released =
      env->GetStaticMethodID(g_registry_class, "onBufferReleased", "(Ljava/lang/String;)V");

  if (!g_on_text_write || !g_on_audio_write || !g_on_finalized || !g_on_released) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    __android_log_print(ANDROID_LOG_ERROR, SEG_ENGINE_LOG_TAG,
                        "GetStaticMethodID failed for SegmentationEngineRegistry hooks");
    return false;
  }
  g_init_ok = true;
  __android_log_print(ANDROID_LOG_INFO, SEG_ENGINE_LOG_TAG, "JNI hooks ready");
  return true;
}

bool EnsureMethods(JNIEnv *env) {
  if (g_init_ok) return true;
  std::lock_guard<std::mutex> lock(g_init_mutex);
  return EnsureMethodsLocked(env);
}

void ClearPendingException(JNIEnv *env) {
  if (env->ExceptionCheck()) {
    env->ExceptionDescribe();
    env->ExceptionClear();
  }
}

}  // namespace

extern "C" void seg_engine_android_hooks_onload(JavaVM *vm) {
  if (!vm) return;
  g_vm = vm;
  JNIEnv *env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK || !env) return;
  std::lock_guard<std::mutex> lock(g_init_mutex);
  EnsureMethodsLocked(env);
}

void seg_engine_on_text_write(const std::string &liveBufferId) {
  bool attached = false;
  JNIEnv *env = GetEnv(&attached);
  if (!env || !EnsureMethods(env)) {
    if (attached && g_vm) g_vm->DetachCurrentThread();
    return;
  }
  jstring jid = env->NewStringUTF(liveBufferId.c_str());
  if (!jid) {
    ClearPendingException(env);
    if (attached) g_vm->DetachCurrentThread();
    return;
  }
  __android_log_print(ANDROID_LOG_DEBUG, SEG_ENGINE_LOG_TAG, "on_text_write id=%s",
                      liveBufferId.c_str());
  env->CallStaticVoidMethod(g_registry_class, g_on_text_write, jid);
  ClearPendingException(env);
  env->DeleteLocalRef(jid);
  if (attached) g_vm->DetachCurrentThread();
}

void seg_engine_on_audio_append(const std::string &liveBufferId, const float *samples,
                                size_t count, int sampleRate, int64_t totalSamplesWritten) {
  bool attached = false;
  JNIEnv *env = GetEnv(&attached);
  if (!env || !EnsureMethods(env)) {
    if (attached && g_vm) g_vm->DetachCurrentThread();
    return;
  }
  jstring jid = env->NewStringUTF(liveBufferId.c_str());
  if (!jid) {
    ClearPendingException(env);
    if (attached) g_vm->DetachCurrentThread();
    return;
  }
  const jsize n = static_cast<jsize>(count > static_cast<size_t>(INT32_MAX) ? INT32_MAX : count);
  jfloatArray jchunk = env->NewFloatArray(n);
  if (!jchunk) {
    ClearPendingException(env);
    env->DeleteLocalRef(jid);
    if (attached) g_vm->DetachCurrentThread();
    return;
  }
  if (n > 0 && samples) {
    env->SetFloatArrayRegion(jchunk, 0, n, samples);
  }
  __android_log_print(ANDROID_LOG_DEBUG, SEG_ENGINE_LOG_TAG,
                      "on_audio_append id=%s count=%d sr=%d total=%lld", liveBufferId.c_str(),
                      static_cast<int>(n), sampleRate,
                      static_cast<long long>(totalSamplesWritten));
  env->CallStaticVoidMethod(g_registry_class, g_on_audio_write, jid, jchunk,
                            static_cast<jint>(sampleRate),
                            static_cast<jlong>(totalSamplesWritten));
  ClearPendingException(env);
  env->DeleteLocalRef(jchunk);
  env->DeleteLocalRef(jid);
  if (attached) g_vm->DetachCurrentThread();
}

void seg_engine_on_buffer_finalized(const std::string &bufferId) {
  bool attached = false;
  JNIEnv *env = GetEnv(&attached);
  if (!env || !EnsureMethods(env)) {
    if (attached && g_vm) g_vm->DetachCurrentThread();
    return;
  }
  jstring jid = env->NewStringUTF(bufferId.c_str());
  if (!jid) {
    ClearPendingException(env);
    if (attached) g_vm->DetachCurrentThread();
    return;
  }
  __android_log_print(ANDROID_LOG_DEBUG, SEG_ENGINE_LOG_TAG, "on_buffer_finalized id=%s",
                      bufferId.c_str());
  env->CallStaticVoidMethod(g_registry_class, g_on_finalized, jid);
  ClearPendingException(env);
  env->DeleteLocalRef(jid);
  if (attached) g_vm->DetachCurrentThread();
}

void seg_engine_on_buffer_released(const std::string &bufferId) {
  bool attached = false;
  JNIEnv *env = GetEnv(&attached);
  if (!env || !EnsureMethods(env)) {
    if (attached && g_vm) g_vm->DetachCurrentThread();
    return;
  }
  jstring jid = env->NewStringUTF(bufferId.c_str());
  if (!jid) {
    ClearPendingException(env);
    if (attached) g_vm->DetachCurrentThread();
    return;
  }
  __android_log_print(ANDROID_LOG_DEBUG, SEG_ENGINE_LOG_TAG, "on_buffer_released id=%s",
                      bufferId.c_str());
  env->CallStaticVoidMethod(g_registry_class, g_on_released, jid);
  ClearPendingException(env);
  env->DeleteLocalRef(jid);
  if (attached) g_vm->DetachCurrentThread();
}
