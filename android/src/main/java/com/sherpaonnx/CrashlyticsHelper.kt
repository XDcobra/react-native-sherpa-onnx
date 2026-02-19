package com.sherpaonnx

import com.facebook.react.bridge.Promise

/** Max length for string values (Crashlytics custom key value limit is 256). */
private const val MAX_ATTR_LENGTH = 200

/**
 * Records promise rejections to Firebase Crashlytics when the host app includes Firebase.
 * If Firebase is not on the classpath, recording is skipped and only [promise.reject] is called.
 */
object CrashlyticsHelper {

  /**
   * Sets context attributes for the next crash/error report (e.g. model type, path, feature).
   * Call before model-dependent operations (STT/TTS init, archive extract) so reports include config.
   * Long strings are truncated to [MAX_ATTR_LENGTH].
   */
  @JvmStatic
  fun setContextAttributes(
    modelDir: String? = null,
    modelType: String? = null,
    feature: String? = null,
    archiveSource: String? = null,
    preferInt8: Boolean? = null,
    numThreads: Int? = null
  ) {
    try {
      val crashlytics = com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance()
      modelDir?.let { crashlytics.setCustomKey("model_dir", truncate(it)) }
      modelType?.let { crashlytics.setCustomKey("model_type", truncate(it)) }
      feature?.let { crashlytics.setCustomKey("feature", it) }
      archiveSource?.let { crashlytics.setCustomKey("archive_source", truncate(it)) }
      preferInt8?.let { crashlytics.setCustomKey("stt_prefer_int8", it.toString()) }
      numThreads?.let { crashlytics.setCustomKey("tts_num_threads", it.toString()) }
    } catch (_: Throwable) { }
  }

  private fun truncate(s: String): String =
    if (s.length <= MAX_ATTR_LENGTH) s else s.take(MAX_ATTR_LENGTH) + "…"

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
