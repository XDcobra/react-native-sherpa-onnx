#include <jni.h>
#include <jsi/jsi.h>

#include "SherpaOnnxJSI.h"

extern "C" JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeInstallJSI(
    JNIEnv *env, jobject /* this */, jlong runtime_ptr, jobject registry) {
  if (runtime_ptr == 0 || registry == nullptr) {
    return JNI_FALSE;
  }

  auto *runtime = reinterpret_cast<facebook::jsi::Runtime *>(runtime_ptr);
  if (!sherpa::cacheJNIReferences(env, registry)) {
    return JNI_FALSE;
  }

  try {
    sherpa::installJSIBindings(*runtime);
    return JNI_TRUE;
  } catch (...) {
    return JNI_FALSE;
  }
}
