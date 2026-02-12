#include <jni.h>
#include <string>
#include <memory>
#include "sherpa-onnx-archive-helper.h"

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

  // Get Promise.resolve and reject methods
  jclass promise_class = env->GetObjectClass(j_promise);
  jmethodID resolve_method = env->GetMethodID(promise_class, "resolve", "(Ljava/lang/Object;)V");
  jmethodID reject_method = env->GetMethodID(promise_class, "reject", 
                                              "(Ljava/lang/String;Ljava/lang/String;)V");

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
    env->CallVoidMethod(j_promise, resolve_method, result_map);
  } else {
    env->CallVoidMethod(result_map, put_string_method,
                        env->NewStringUTF("reason"), env->NewStringUTF(error_msg.c_str()));
    env->CallVoidMethod(j_promise, reject_method,
                        env->NewStringUTF("ARCHIVE_ERROR"),
                        env->NewStringUTF(error_msg.c_str()));
  }

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
Java_com_sherpaonnx_SherpaOnnxArchiveHelper_nativeCancelExtract(JNIEnv* /* env */, jobject /* jthis */) {
  ArchiveHelper::Cancel();
}
