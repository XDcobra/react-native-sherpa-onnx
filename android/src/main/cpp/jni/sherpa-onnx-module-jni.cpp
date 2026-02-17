// Minimal JNI for SherpaOnnxModule (test init; model-detect JNI can be added here later).
#include <jni.h>
#include <string>

extern "C" {

// Test that native library is loaded; no sherpa-onnx C-API dependency.
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTestSherpaInit(JNIEnv* env, jobject /* this */) {
  return env->NewStringUTF("sherpa-onnx native (libsherpaonnx) loaded");
}

}  // extern "C"
