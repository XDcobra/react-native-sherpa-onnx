package com.sherpaonnx.tts.config

import com.facebook.react.bridge.ReadableMap

/** ReadableMap option helpers for TTS generation. */
internal object TtsGenerationOptionsParser {
  /** Parse sid and speed from options with defaults. */
  fun getSid(options: ReadableMap?): Int =
    if (options != null && options.hasKey("sid")) options.getDouble("sid").toInt() else 0

  fun getSpeed(options: ReadableMap?): Float =
    if (options != null && options.hasKey("speed")) options.getDouble("speed").toFloat() else 1.0f
}
