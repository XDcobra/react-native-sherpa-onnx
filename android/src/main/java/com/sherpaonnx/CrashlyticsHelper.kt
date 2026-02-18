package com.sherpaonnx

import com.facebook.react.bridge.Promise

/**
 * Records promise rejections to Firebase Crashlytics when the host app includes Firebase.
 * If Firebase is not on the classpath, recording is skipped and only [promise.reject] is called.
 */
object CrashlyticsHelper {

  /**
   * Records the error to Crashlytics (if available) then rejects the promise.
   * [feature] is optional context (e.g. "stt", "tts", "archive") for filtering in the Firebase console.
   */
  @JvmStatic
  fun rejectWithCrashlytics(
    promise: Promise,
    code: String,
    message: String,
    throwable: Throwable? = null,
    feature: String? = null
  ) {
    try {
      val crashlytics = com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance()
      crashlytics.setCustomKey("reject_code", code)
      if (!feature.isNullOrBlank()) {
        crashlytics.setCustomKey("feature", feature)
      }
      crashlytics.recordException(throwable ?: Exception(message))
    } catch (_: Throwable) {
      // Firebase not on classpath or not initialized (e.g. app doesn't use Crashlytics)
    }
    if (throwable != null) {
      promise.reject(code, message, throwable)
    } else {
      promise.reject(code, message)
    }
  }
}
