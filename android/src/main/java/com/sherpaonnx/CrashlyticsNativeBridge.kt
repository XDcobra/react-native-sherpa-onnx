package com.sherpaonnx

/**
 * Bridge for native (C++) JNI code to record errors to Firebase Crashlytics.
 * Called from JNI before rejecting a promise so that native-layer failures appear in Crashlytics.
 */
object CrashlyticsNativeBridge {

  private const val FEATURE_NATIVE = "native"

  /**
   * Records an error to Crashlytics. Safe to call from JNI; no-op if Firebase is not available.
   */
  @JvmStatic
  fun recordError(code: String, message: String) {
    try {
      val crashlytics = com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance()
      crashlytics.setCustomKey("reject_code", code)
      crashlytics.setCustomKey("feature", FEATURE_NATIVE)
      crashlytics.recordException(Exception("[$code] $message"))
    } catch (_: Throwable) {
      // Firebase not on classpath or not initialized
    }
  }
}
