package com.sherpaonnx.tts.system

import android.speech.tts.TextToSpeech
import android.util.Log

/** Shared log tag and formatters for Android system TTS (`adb logcat -s SherpaSystemTts`). */
internal object SystemTtsLog {
  const val TAG = "SherpaSystemTts"

  fun i(message: String) {
    Log.i(TAG, message)
  }

  fun w(message: String) {
    Log.w(TAG, message)
  }

  fun langRequest(lang: String?, country: String?, variant: String?): String =
    "lang=${lang.orEmpty()} country=${country.orEmpty()} variant=${variant.orEmpty()}"

  fun languageTriple(triple: Array<String>): String =
    "[${triple.getOrElse(0) { "" }}, ${triple.getOrElse(1) { "" }}, ${triple.getOrElse(2) { "" }}]"

  fun langAvailabilityName(code: Int): String =
    when (code) {
      TextToSpeech.LANG_AVAILABLE -> "LANG_AVAILABLE"
      TextToSpeech.LANG_COUNTRY_AVAILABLE -> "LANG_COUNTRY_AVAILABLE"
      TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> "LANG_COUNTRY_VAR_AVAILABLE"
      TextToSpeech.LANG_NOT_SUPPORTED -> "LANG_NOT_SUPPORTED"
      TextToSpeech.LANG_MISSING_DATA -> "LANG_MISSING_DATA"
      else -> "code=$code"
    }

  fun joinLimited(items: List<String>, maxItems: Int = 12): String {
    if (items.isEmpty()) {
      return "(empty)"
    }
    val head = items.take(maxItems).joinToString(", ")
    return if (items.size > maxItems) "$head, …+${items.size - maxItems}" else head
  }
}
