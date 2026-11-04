#include <jni.h>
#include <jsi/jsi.h>

#include "SherpaOnnxJSI.h"

extern "C" JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeInstallJSI(JNIEnv * /*env*/, jobject /* this */,
                                                      jlong runtime_ptr) {
  if (runtime_ptr == 0) {
    return JNI_FALSE;
  }

  auto *runtime = reinterpret_cast<facebook::jsi::Runtime *>(runtime_ptr);
  try {
    sherpa::installJSIBindings(*runtime);
    return JNI_TRUE;
  } catch (...) {
    return JNI_FALSE;
  }
}
