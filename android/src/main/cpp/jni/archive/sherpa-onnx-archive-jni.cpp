/**
 * sherpa-onnx-archive-jni.cpp
 *
 * JNI bindings for ArchiveHelper: nativeExtract, nativeExtractFromStream,
 * nativeCancelOperation, nativeComputeFileSha256.
 */
#include <jni.h>
#include <string>
#include "sherpa-onnx-archive-helper.h"
#include <android/log.h>

static JavaVM* g_vm = nullptr;

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  g_vm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return -1;
  }
  return JNI_VERSION_1_6;
}

// ── Helpers ──────────────────────────────────────────────────────

namespace {

/** Build a WritableMap from ExtractionResult and resolve the promise. */
static void ResolveWithExtractionResult(
    JNIEnv* env, jobject j_promise, const ExtractionResult& result, const std::string& target_path) {
  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve_method = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");

  jclass arguments_class = env->FindClass("com/facebook/react/bridge/Arguments");
  jmethodID create_map = env->GetStaticMethodID(arguments_class, "createMap",
                                                  "()Lcom/facebook/react/bridge/WritableMap;");
  jobject map = env->CallStaticObjectMethod(arguments_class, create_map);

  jclass map_class = env->FindClass("com/facebook/react/bridge/WritableMap");
  jmethodID putBoolean = env->GetMethodID(map_class, "putBoolean", "(Ljava/lang/String;Z)V");
  jmethodID putString = env->GetMethodID(map_class, "putString",
                                          "(Ljava/lang/String;Ljava/lang/String;)V");
  jmethodID putInt = env->GetMethodID(map_class, "putInt", "(Ljava/lang/String;I)V");
  jmethodID putDouble = env->GetMethodID(map_class, "putDouble", "(Ljava/lang/String;D)V");

  env->CallVoidMethod(map, putBoolean, env->NewStringUTF("success"),
                       result.success ? JNI_TRUE : JNI_FALSE);
  env->CallVoidMethod(map, putBoolean, env->NewStringUTF("paused"),
                       result.paused ? JNI_TRUE : JNI_FALSE);
  env->CallVoidMethod(map, putInt, env->NewStringUTF("lastEntryIndex"),
                       result.last_entry_index);
  env->CallVoidMethod(map, putDouble, env->NewStringUTF("bytesExtracted"),
                       static_cast<double>(result.bytes_extracted));

  if (!result.last_entry_path.empty()) {
    env->CallVoidMethod(map, putString, env->NewStringUTF("lastEntryPath"),
                         env->NewStringUTF(result.last_entry_path.c_str()));
  }

  if (result.success) {
    env->CallVoidMethod(map, putString, env->NewStringUTF("path"),
                         env->NewStringUTF(target_path.c_str()));
    if (!result.sha256.empty()) {
      env->CallVoidMethod(map, putString, env->NewStringUTF("sha256"),
                           env->NewStringUTF(result.sha256.c_str()));
    }
  } else if (!result.paused) {
    __android_log_print(ANDROID_LOG_WARN, "SherpaOnnxNative",
                         "[ARCHIVE_ERROR] %s", result.error.c_str());
    env->CallVoidMethod(map, putString, env->NewStringUTF("reason"),
                         env->NewStringUTF(result.error.c_str()));
  }

  env->CallVoidMethod(j_promise, resolve_method, map);

  env->DeleteLocalRef(map);
  env->DeleteLocalRef(promise_class);
  env->DeleteLocalRef(arguments_class);
  env->DeleteLocalRef(map_class);
}

/** Create a progress callback that forwards to a Java lambda via JNI. */
static ArchiveHelper::ProgressCallback MakeProgressCallback(
    jobject j_callback_global, jmethodID method) {
  if (!j_callback_global || !method) return nullptr;

  return [j_callback_global, method](
      long long bytes, long long total, double percent, int entry_index) {
    JNIEnv* env = nullptr;
    bool should_detach = false;

    if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
      if (g_vm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
        should_detach = true;
      } else {
        return;
      }
    }

    if (env) {
      env->CallVoidMethod(j_callback_global, method, bytes, total, percent);
      if (env->ExceptionCheck()) env->ExceptionClear();
      if (should_detach) g_vm->DetachCurrentThread();
    }
  };
}

// ── Stream read context ─────────────────────────────────────────

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

// ── JNI: nativeExtract ──────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtract(
    JNIEnv* env,
    jobject,
    jstring j_source_path,
    jstring j_target_path,
    jboolean j_force,
    jint j_skip_entries,
    jstring j_operation_id,
    jobject j_progress_callback,
    jobject j_promise) {

  const char* src = env->GetStringUTFChars(j_source_path, nullptr);
  const char* tgt = env->GetStringUTFChars(j_target_path, nullptr);
  const char* opId = env->GetStringUTFChars(j_operation_id, nullptr);
  std::string source_str(src), target_str(tgt), operation_id(opId);
  env->ReleaseStringUTFChars(j_source_path, src);
  env->ReleaseStringUTFChars(j_target_path, tgt);
  env->ReleaseStringUTFChars(j_operation_id, opId);

  // Progress callback
  jmethodID progress_method = nullptr;
  jobject callback_global = nullptr;
  if (j_progress_callback) {
    jclass cb_class = env->GetObjectClass(j_progress_callback);
    progress_method = env->GetMethodID(cb_class, "invoke", "(JJD)V");
    env->DeleteLocalRef(cb_class);
    callback_global = env->NewGlobalRef(j_progress_callback);
  }

  auto on_progress = MakeProgressCallback(callback_global, progress_method);

  ExtractionResult result = ArchiveHelper::Extract(
      source_str, target_str, j_force == JNI_TRUE,
      static_cast<int>(j_skip_entries), on_progress, operation_id);

  ResolveWithExtractionResult(env, j_promise, result, target_str);

  if (callback_global) env->DeleteGlobalRef(callback_global);
}

// ── JNI: nativeExtractFromStream ────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeExtractFromStream(
    JNIEnv* env,
    jobject,
    jobject j_input_stream,
    jstring j_target_path,
    jboolean j_force,
    jint j_skip_entries,
    jstring j_operation_id,
    jobject j_progress_callback,
    jobject j_promise) {

  const char* tgt = env->GetStringUTFChars(j_target_path, nullptr);
  const char* opId = env->GetStringUTFChars(j_operation_id, nullptr);
  std::string target_str(tgt), operation_id(opId);
  env->ReleaseStringUTFChars(j_target_path, tgt);
  env->ReleaseStringUTFChars(j_operation_id, opId);

  // Setup stream read context
  jobject stream_global = env->NewGlobalRef(j_input_stream);
  jclass stream_class = env->GetObjectClass(j_input_stream);
  jmethodID read_method = env->GetMethodID(stream_class, "read", "([B)I");
  env->DeleteLocalRef(stream_class);

  if (!read_method) {
    env->DeleteGlobalRef(stream_global);
    jclass promise_class = env->GetObjectClass(j_promise);
    jmethodID reject = env->GetMethodID(promise_class, "reject",
                                          "(Ljava/lang/String;Ljava/lang/String;)V");
    env->CallVoidMethod(j_promise, reject,
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

  // Progress callback
  jmethodID progress_method = nullptr;
  jobject callback_global = nullptr;
  if (j_progress_callback) {
    jclass cb_class = env->GetObjectClass(j_progress_callback);
    progress_method = env->GetMethodID(cb_class, "invoke", "(JJD)V");
    env->DeleteLocalRef(cb_class);
    callback_global = env->NewGlobalRef(j_progress_callback);
  }

  auto on_progress = MakeProgressCallback(callback_global, progress_method);

  ExtractionResult result = ArchiveHelper::ExtractFromStream(
      &JniStreamRead, &read_ctx, target_str, j_force == JNI_TRUE,
      static_cast<int>(j_skip_entries), on_progress, operation_id);

  ResolveWithExtractionResult(env, j_promise, result, target_str);

  env->DeleteGlobalRef(stream_global);
  env->DeleteLocalRef(byte_array);
  if (callback_global) env->DeleteGlobalRef(callback_global);
}

// ── JNI: nativeCancelOperation ──────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeCancelOperation(
    JNIEnv* env, jobject, jstring j_operation_id) {
  const char* opId = env->GetStringUTFChars(j_operation_id, nullptr);
  ArchiveHelper::CancelOperation(std::string(opId));
  env->ReleaseStringUTFChars(j_operation_id, opId);
}

// ── JNI: nativeComputeFileSha256 ────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeComputeFileSha256(
    JNIEnv* env, jobject, jstring j_file_path, jobject j_promise) {
  const char* path = env->GetStringUTFChars(j_file_path, nullptr);
  std::string file_str(path);
  env->ReleaseStringUTFChars(j_file_path, path);

  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");
  jmethodID reject = env->GetMethodID(promise_class, "reject",
                                        "(Ljava/lang/String;Ljava/lang/String;)V");

  std::string error_msg, sha256;
  bool success = ArchiveHelper::ComputeFileSha256(file_str, &error_msg, &sha256);

  if (success) {
    env->CallVoidMethod(j_promise, resolve, env->NewStringUTF(sha256.c_str()));
  } else {
    __android_log_print(ANDROID_LOG_WARN, "SherpaOnnxNative",
                         "[CHECKSUM_ERROR] %s", error_msg.c_str());
    env->CallVoidMethod(j_promise, reject,
                         env->NewStringUTF("CHECKSUM_ERROR"),
                         env->NewStringUTF(error_msg.c_str()));
  }

  env->DeleteLocalRef(promise_class);
}
