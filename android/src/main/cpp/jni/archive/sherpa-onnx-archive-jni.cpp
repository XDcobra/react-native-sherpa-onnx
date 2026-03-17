/**
 * sherpa-onnx-archive-jni.cpp
 *
 * Purpose: JNI bindings for SherpaOnnxArchiveHelper (Kotlin): nativeExtractTarBz2,
 * nativeCancelExtract, nativeComputeFileSha256. Bridges to sherpa-onnx-archive-helper.cpp.
 */
#include <jni.h>
#include <string>
#include <memory>
#include "sherpa-onnx-archive-helper.h"
#include <android/log.h>

static JavaVM* g_vm = nullptr;

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /* reserved */) {
  g_vm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return -1;
  }
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtractTarBz2(
    JNIEnv* env,
    jobject /* jthis */,
    jstring j_source_path,
    jstring j_target_path,
    jboolean j_force,
    jobject j_progress_callback,
    jobject j_promise) {
  const char* source_path = env->GetStringUTFChars(j_source_path, nullptr);
  const char* target_path = env->GetStringUTFChars(j_target_path, nullptr);
  std::string source_str(source_path);
  std::string target_str(target_path);
  env->ReleaseStringUTFChars(j_source_path, source_path);
  env->ReleaseStringUTFChars(j_target_path, target_path);

  // Get method for onProgress if callback provided
  jmethodID on_progress_method = nullptr;
  jobject j_progress_callback_global = nullptr;
  if (j_progress_callback != nullptr) {
    jclass callback_class = env->GetObjectClass(j_progress_callback);
    on_progress_method = env->GetMethodID(
        callback_class, "invoke", "(JJD)V");
    env->DeleteLocalRef(callback_class);
    // Store as global reference to ensure validity across potential thread boundaries
    j_progress_callback_global = env->NewGlobalRef(j_progress_callback);
  }

  // Get Promise.resolve method
  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve_method = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");

  // Get WritableMap from Arguments
  jclass arguments_class = env->FindClass("com/facebook/react/bridge/Arguments");
  jmethodID create_map_method = env->GetStaticMethodID(
      arguments_class, "createMap", "()Lcom/facebook/react/bridge/WritableMap;");
  jobject result_map = env->CallStaticObjectMethod(arguments_class, create_map_method);

  jclass writeable_map_class = env->FindClass("com/facebook/react/bridge/WritableMap");
  jmethodID put_boolean_method = env->GetMethodID(
      writeable_map_class, "putBoolean", "(Ljava/lang/String;Z)V");
  jmethodID put_string_method = env->GetMethodID(
      writeable_map_class, "putString", "(Ljava/lang/String;Ljava/lang/String;)V");

  // Progress callback wrapper - JNI-safe version
  auto on_progress = [j_progress_callback_global, on_progress_method](
      long long bytes_extracted, long long total_bytes, double percent) {
    if (j_progress_callback_global != nullptr && on_progress_method != nullptr) {
      // Get JNIEnv for current thread
      JNIEnv* callback_env = nullptr;
      bool should_detach = false;
      
      if (g_vm->GetEnv(reinterpret_cast<void**>(&callback_env), JNI_VERSION_1_6) == JNI_EDETACHED) {
        // Thread not attached, attach it
        if (g_vm->AttachCurrentThread(&callback_env, nullptr) == JNI_OK) {
          should_detach = true;
        } else {
          return; // Failed to attach, skip callback
        }
      }
      
      if (callback_env != nullptr) {
        callback_env->CallVoidMethod(j_progress_callback_global, on_progress_method,
                            bytes_extracted, total_bytes, percent);
        
        // Check and clear any exceptions from the callback
        if (callback_env->ExceptionCheck()) {
          callback_env->ExceptionClear();
        }
        
        // Detach if we attached in this call
        if (should_detach) {
          g_vm->DetachCurrentThread();
        }
      }
    }
  };

    // Perform extraction
    std::string error_msg;
    std::string sha256;
    bool success = ArchiveHelper::ExtractTarBz2(
      source_str,
      target_str,
      j_force == JNI_TRUE,
      on_progress,
      &error_msg,
      &sha256);

  // Build result map
  env->CallVoidMethod(result_map, put_boolean_method,
                      env->NewStringUTF("success"), success ? JNI_TRUE : JNI_FALSE);

  if (success) {
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("path"), env->NewStringUTF(target_str.c_str()));
    if (!sha256.empty()) {
      env->CallVoidMethod(result_map, put_string_method,
                          env->NewStringUTF("sha256"), env->NewStringUTF(sha256.c_str()));
    }
  } else {
    __android_log_print(ANDROID_LOG_WARN, "SherpaOnnxNative", "[ARCHIVE_ERROR] %s", error_msg.c_str());
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("reason"), env->NewStringUTF(error_msg.c_str()));
  }
  env->CallVoidMethod(j_promise, resolve_method, result_map);

  // Clean up global reference
  if (j_progress_callback_global != nullptr) {
    env->DeleteGlobalRef(j_progress_callback_global);
  }

  env->DeleteLocalRef(result_map);
  env->DeleteLocalRef(promise_class);
  env->DeleteLocalRef(arguments_class);
  env->DeleteLocalRef(writeable_map_class);
}

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtractTarZst(
    JNIEnv* env,
    jobject /* jthis */,
    jstring j_source_path,
    jstring j_target_path,
    jboolean j_force,
    jobject j_progress_callback,
    jobject j_promise) {
  const char* source_path = env->GetStringUTFChars(j_source_path, nullptr);
  const char* target_path = env->GetStringUTFChars(j_target_path, nullptr);
  std::string source_str(source_path);
  std::string target_str(target_path);
  env->ReleaseStringUTFChars(j_source_path, source_path);
  env->ReleaseStringUTFChars(j_target_path, target_path);

  jmethodID on_progress_method = nullptr;
  jobject j_progress_callback_global = nullptr;
  if (j_progress_callback != nullptr) {
    jclass callback_class = env->GetObjectClass(j_progress_callback);
    on_progress_method = env->GetMethodID(callback_class, "invoke", "(JJD)V");
    env->DeleteLocalRef(callback_class);
    j_progress_callback_global = env->NewGlobalRef(j_progress_callback);
  }

  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve_method = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");

  jclass arguments_class = env->FindClass("com/facebook/react/bridge/Arguments");
  jmethodID create_map_method = env->GetStaticMethodID(
      arguments_class, "createMap", "()Lcom/facebook/react/bridge/WritableMap;");
  jobject result_map = env->CallStaticObjectMethod(arguments_class, create_map_method);

  jclass writeable_map_class = env->FindClass("com/facebook/react/bridge/WritableMap");
  jmethodID put_boolean_method = env->GetMethodID(
      writeable_map_class, "putBoolean", "(Ljava/lang/String;Z)V");
  jmethodID put_string_method = env->GetMethodID(
      writeable_map_class, "putString", "(Ljava/lang/String;Ljava/lang/String;)V");

  auto on_progress = [j_progress_callback_global, on_progress_method](
      long long bytes_extracted, long long total_bytes, double percent) {
    if (j_progress_callback_global != nullptr && on_progress_method != nullptr) {
      JNIEnv* callback_env = nullptr;
      bool should_detach = false;
      if (g_vm->GetEnv(reinterpret_cast<void**>(&callback_env), JNI_VERSION_1_6) == JNI_EDETACHED) {
        if (g_vm->AttachCurrentThread(&callback_env, nullptr) == JNI_OK) {
          should_detach = true;
        } else {
          return;
        }
      }
      if (callback_env != nullptr) {
        callback_env->CallVoidMethod(j_progress_callback_global, on_progress_method,
                            bytes_extracted, total_bytes, percent);
        if (callback_env->ExceptionCheck()) {
          callback_env->ExceptionClear();
        }
        if (should_detach) {
          g_vm->DetachCurrentThread();
        }
      }
    }
  };

  std::string error_msg;
  std::string sha256;
  bool success = ArchiveHelper::ExtractTarZst(
      source_str,
      target_str,
      j_force == JNI_TRUE,
      on_progress,
      &error_msg,
      &sha256);

  env->CallVoidMethod(result_map, put_boolean_method,
                      env->NewStringUTF("success"), success ? JNI_TRUE : JNI_FALSE);

  if (success) {
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("path"), env->NewStringUTF(target_str.c_str()));
    if (!sha256.empty()) {
      env->CallVoidMethod(result_map, put_string_method,
                          env->NewStringUTF("sha256"), env->NewStringUTF(sha256.c_str()));
    }
  } else {
    __android_log_print(ANDROID_LOG_WARN, "SherpaOnnxNative", "[ARCHIVE_ERROR] %s", error_msg.c_str());
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("reason"), env->NewStringUTF(error_msg.c_str()));
  }
  env->CallVoidMethod(j_promise, resolve_method, result_map);

  if (j_progress_callback_global != nullptr) {
    env->DeleteGlobalRef(j_progress_callback_global);
  }

  env->DeleteLocalRef(result_map);
  env->DeleteLocalRef(promise_class);
  env->DeleteLocalRef(arguments_class);
  env->DeleteLocalRef(writeable_map_class);
}

namespace {
struct InputStreamReadContext {
  JNIEnv* env = nullptr;
  jobject stream_global = nullptr;
  jmethodID read_method = nullptr;
  jbyteArray byte_array = nullptr;
  const size_t buffer_size = 64 * 1024;
};

static std::ptrdiff_t JniStreamRead(void* buf, size_t len, void* user_data) {
  auto* ctx = static_cast<InputStreamReadContext*>(user_data);
  if (!ctx || !ctx->env || !ctx->stream_global || !ctx->read_method || !ctx->byte_array) {
    return -1;
  }
  size_t to_read = (len < ctx->buffer_size) ? len : ctx->buffer_size;
  jint n = ctx->env->CallIntMethod(ctx->stream_global, ctx->read_method, ctx->byte_array);
  if (ctx->env->ExceptionCheck()) {
    ctx->env->ExceptionClear();
    return -1;
  }
  if (n <= 0) return 0;
  ctx->env->GetByteArrayRegion(ctx->byte_array, 0, n, static_cast<jbyte*>(buf));
  return static_cast<std::ptrdiff_t>(n);
}
}  // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtractTarZstFromStream(
    JNIEnv* env,
    jobject /* jthis */,
    jobject j_input_stream,
    jstring j_target_path,
    jboolean j_force,
    jobject j_progress_callback,
    jobject j_promise) {
  const char* target_path = env->GetStringUTFChars(j_target_path, nullptr);
  std::string target_str(target_path);
  env->ReleaseStringUTFChars(j_target_path, target_path);

  jobject stream_global = env->NewGlobalRef(j_input_stream);
  jclass stream_class = env->GetObjectClass(j_input_stream);
  jmethodID read_method = env->GetMethodID(stream_class, "read", "([B)I");
  env->DeleteLocalRef(stream_class);
  if (!read_method) {
    env->DeleteGlobalRef(stream_global);
    jclass promise_class = env->GetObjectClass(j_promise);
    jmethodID reject_method = env->GetMethodID(promise_class, "reject", "(Ljava/lang/String;Ljava/lang/String;)V");
    env->CallVoidMethod(j_promise, reject_method,
                        env->NewStringUTF("ARCHIVE_ERROR"),
                        env->NewStringUTF("InputStream.read([B)I not found"));
    env->DeleteLocalRef(promise_class);
    return;
  }

  jbyteArray byte_array = env->NewByteArray(static_cast<jsize>(64 * 1024));
  if (!byte_array) {
    env->DeleteGlobalRef(stream_global);
    return;
  }

  InputStreamReadContext read_ctx;
  read_ctx.env = env;
  read_ctx.stream_global = stream_global;
  read_ctx.read_method = read_method;
  read_ctx.byte_array = byte_array;

  jmethodID on_progress_method = nullptr;
  jobject j_progress_callback_global = nullptr;
  if (j_progress_callback != nullptr) {
    jclass callback_class = env->GetObjectClass(j_progress_callback);
    on_progress_method = env->GetMethodID(callback_class, "invoke", "(JJD)V");
    env->DeleteLocalRef(callback_class);
    j_progress_callback_global = env->NewGlobalRef(j_progress_callback);
  }

  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve_method = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");

  jclass arguments_class = env->FindClass("com/facebook/react/bridge/Arguments");
  jmethodID create_map_method = env->GetStaticMethodID(arguments_class, "createMap", "()Lcom/facebook/react/bridge/WritableMap;");
  jobject result_map = env->CallStaticObjectMethod(arguments_class, create_map_method);

  jclass writeable_map_class = env->FindClass("com/facebook/react/bridge/WritableMap");
  jmethodID put_boolean_method = env->GetMethodID(writeable_map_class, "putBoolean", "(Ljava/lang/String;Z)V");
  jmethodID put_string_method = env->GetMethodID(writeable_map_class, "putString", "(Ljava/lang/String;Ljava/lang/String;)V");

  auto on_progress = [j_progress_callback_global, on_progress_method](
      long long bytes_extracted, long long total_bytes, double percent) {
    if (j_progress_callback_global != nullptr && on_progress_method != nullptr) {
      JNIEnv* callback_env = nullptr;
      bool should_detach = false;
      if (g_vm->GetEnv(reinterpret_cast<void**>(&callback_env), JNI_VERSION_1_6) == JNI_EDETACHED) {
        if (g_vm->AttachCurrentThread(&callback_env, nullptr) == JNI_OK) {
          should_detach = true;
        } else {
          return;
        }
      }
      if (callback_env != nullptr) {
        callback_env->CallVoidMethod(j_progress_callback_global, on_progress_method,
                            bytes_extracted, total_bytes, percent);
        if (callback_env->ExceptionCheck()) {
          callback_env->ExceptionClear();
        }
        if (should_detach) {
          g_vm->DetachCurrentThread();
        }
      }
    }
  };

  std::string error_msg;
  std::string sha256;
  bool success = ArchiveHelper::ExtractFromStream(
      &JniStreamRead,
      &read_ctx,
      target_str,
      j_force == JNI_TRUE,
      on_progress,
      &error_msg,
      &sha256);

  env->CallVoidMethod(result_map, put_boolean_method,
                      env->NewStringUTF("success"), success ? JNI_TRUE : JNI_FALSE);

  if (success) {
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("path"), env->NewStringUTF(target_str.c_str()));
    if (!sha256.empty()) {
      env->CallVoidMethod(result_map, put_string_method,
                          env->NewStringUTF("sha256"), env->NewStringUTF(sha256.c_str()));
    }
  } else {
    __android_log_print(ANDROID_LOG_WARN, "SherpaOnnxNative", "[ARCHIVE_ERROR] %s", error_msg.c_str());
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("reason"), env->NewStringUTF(error_msg.c_str()));
  }
  env->CallVoidMethod(j_promise, resolve_method, result_map);

  env->DeleteGlobalRef(stream_global);
  env->DeleteLocalRef(byte_array);
  if (j_progress_callback_global != nullptr) {
    env->DeleteGlobalRef(j_progress_callback_global);
  }
  env->DeleteLocalRef(result_map);
  env->DeleteLocalRef(promise_class);
  env->DeleteLocalRef(arguments_class);
  env->DeleteLocalRef(writeable_map_class);
}

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtractTarBz2FromStream(
    JNIEnv* env,
    jobject jthis,
    jobject j_input_stream,
    jstring j_target_path,
    jboolean j_force,
    jobject j_progress_callback,
    jobject j_promise) {
  Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtractTarZstFromStream(
      env, jthis, j_input_stream, j_target_path, j_force, j_progress_callback, j_promise);
}

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeCancelExtract(JNIEnv* /* env */, jobject /* jthis */) {
  ArchiveHelper::Cancel();
}

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeComputeFileSha256(
    JNIEnv* env,
    jobject /* jthis */,
    jstring j_file_path,
    jobject j_promise) {
  const char* file_path = env->GetStringUTFChars(j_file_path, nullptr);
  std::string file_str(file_path);
  env->ReleaseStringUTFChars(j_file_path, file_path);

  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve_method = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");
  jmethodID reject_method = env->GetMethodID(
      promise_class, "reject", "(Ljava/lang/String;Ljava/lang/String;)V");

  std::string error_msg;
  std::string sha256;
  bool success = ArchiveHelper::ComputeFileSha256(file_str, &error_msg, &sha256);

  if (success) {
    env->CallVoidMethod(j_promise, resolve_method, env->NewStringUTF(sha256.c_str()));
  } else {
    __android_log_print(ANDROID_LOG_WARN, "SherpaOnnxNative", "[CHECKSUM_ERROR] %s", error_msg.c_str());
    env->CallVoidMethod(j_promise, reject_method,
                        env->NewStringUTF("CHECKSUM_ERROR"),
                        env->NewStringUTF(error_msg.c_str()));
  }

  env->DeleteLocalRef(promise_class);
}
