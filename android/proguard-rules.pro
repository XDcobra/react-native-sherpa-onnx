# Consumer ProGuard rules for react-native-sherpa-onnx.
# These are merged into the app's ProGuard config when the library is used in release builds.

# JNI: native code looks up progress callback by class and method "invoke(JJD)V".
# R8/ProGuard must not rename or remove the callback class or method.
-keep class com.sherpaonnx.SherpaOnnxArchiveHelper { *; }
-keep class com.sherpaonnx.SherpaOnnxArchiveHelper$* { *; }
