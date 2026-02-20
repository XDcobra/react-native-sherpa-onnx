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
   * STT-specific keys (stt_*) are set when the corresponding params are non-null.
   */
  @JvmStatic
  fun setContextAttributes(
    modelDir: String? = null,
    modelType: String? = null,
    feature: String? = null,
    archiveSource: String? = null,
    preferInt8: Boolean? = null,
    numThreads: Int? = null,
    // STT init options (for feature = "stt")
    sttNumThreads: Int? = null,
    sttHotwordsFile: String? = null,
    sttHotwordsScore: Float? = null,
    sttProvider: String? = null,
    sttRuleFsts: String? = null,
    sttRuleFars: String? = null,
    sttDither: Float? = null,
    sttDecodingMethod: String? = null,
    sttMaxActivePaths: Int? = null,
    sttModelOptionsSummary: String? = null
  ) {
    try {
      val crashlytics = com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance()
      modelDir?.let { crashlytics.setCustomKey("model_dir", truncate(it)) }
      modelType?.let { crashlytics.setCustomKey("model_type", truncate(it)) }
      feature?.let { crashlytics.setCustomKey("feature", it) }
      archiveSource?.let { crashlytics.setCustomKey("archive_source", truncate(it)) }
      preferInt8?.let { crashlytics.setCustomKey("stt_prefer_int8", it.toString()) }
      numThreads?.let { crashlytics.setCustomKey("tts_num_threads", it.toString()) }
      sttNumThreads?.let { crashlytics.setCustomKey("stt_num_threads", it.toString()) }
      sttHotwordsFile?.takeIf { it.isNotBlank() }?.let { crashlytics.setCustomKey("stt_hotwords_file", truncate(it)) }
      sttHotwordsScore?.let { crashlytics.setCustomKey("stt_hotwords_score", it.toString()) }
      sttProvider?.takeIf { it.isNotBlank() }?.let { crashlytics.setCustomKey("stt_provider", truncate(it)) }
      sttRuleFsts?.takeIf { it.isNotBlank() }?.let { crashlytics.setCustomKey("stt_rule_fsts", truncate(it)) }
      sttRuleFars?.takeIf { it.isNotBlank() }?.let { crashlytics.setCustomKey("stt_rule_fars", truncate(it)) }
      sttDither?.let { crashlytics.setCustomKey("stt_dither", it.toString()) }
      sttDecodingMethod?.takeIf { it.isNotBlank() }?.let { crashlytics.setCustomKey("stt_decoding_method", it) }
      sttMaxActivePaths?.let { crashlytics.setCustomKey("stt_max_active_paths", it.toString()) }
      sttModelOptionsSummary?.takeIf { it.isNotBlank() }?.let { crashlytics.setCustomKey("stt_model_options", truncate(it)) }
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
