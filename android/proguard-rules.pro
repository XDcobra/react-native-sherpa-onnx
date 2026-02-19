# Keep CrashlyticsNativeBridge for JNI calls from native code
# This class and method are invoked via FindClass/GetStaticMethodID from C++,
# so R8 cannot detect the reference and may remove them during minification.
-keep class com.sherpaonnx.CrashlyticsNativeBridge {
    public static void recordError(java.lang.String, java.lang.String);
}
