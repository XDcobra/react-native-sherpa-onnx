package com.sherpaonnx.tts.config

import com.facebook.react.bridge.ReadableMap

/** ReadableMap option helpers for TTS generation. */
internal object TtsGenerationOptionsParser {
  /** Parse sid and speed from options with defaults. */
  fun getSid(options: ReadableMap?): Int =
    if (options != null && options.hasKey("sid")) options.getDouble("sid").toInt() else 0

  fun getSpeed(options: ReadableMap?): Float =
    if (options != null && options.hasKey("speed")) options.getDouble("speed").toFloat() else 1.0f

  /** Merge `extra` map; top-level `lang` wins over `extra.lang`. */
  fun buildExtraMap(options: ReadableMap?): Map<String, String>? {
    if (options == null) return null
    val out = linkedMapOf<String, String>()
    if (options.hasKey("extra") && !options.isNull("extra")) {
      val map = options.getMap("extra") ?: return null
      val it = map.keySetIterator()
      while (it.hasNextKey()) {
        val k = it.nextKey()
        map.getString(k)?.let { v -> out[k] = v }
      }
    }
    if (options.hasKey("lang") && !options.isNull("lang")) {
      options.getString("lang")?.trim()?.takeIf { it.isNotEmpty() }?.let { out["lang"] = it }
    }
    return out.takeIf { it.isNotEmpty() }
  }
}
