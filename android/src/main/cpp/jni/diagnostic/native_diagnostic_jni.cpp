#include "NativeDiagnostic.h"
#include "jni/jni_utf8.h"

#include <jni.h>

extern "C" {

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeInitDiagnostics(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jboolean enabled,
    jboolean installSignalHandler) {
  sherpa::diag::SetEnabled(enabled == JNI_TRUE);
  sherpa::diag::SetInstallSignalHandler(installSignalHandler == JNI_TRUE);
  sherpa::diag::Init(installSignalHandler == JNI_TRUE);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeGetDiagnosticSnapshot(JNIEnv* env, jobject /*thiz*/) {
  const std::string json = sherpa::diag::GetSnapshotJson();
  return sherpaonnx::NewJStringUtf8(env, json);
}

} // extern "C"
