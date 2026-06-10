package com.sherpaonnx.vad.config

import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.bridge.InitModeModelPathsParser

/** Parse `initializeVad(instanceId, options)` TurboModule map. */
internal object VadInitOptionsParser {
  data class Parsed(
    val initMode: String,
    val modelDir: String?,
    val modelPaths: Map<String, String>?,
    val modelType: String,
    val sampleRate: Int,
    val threshold: Double?,
    val minSpeechDurationMs: Int,
    val minSilenceDurationMs: Int,
    val windowSize: Int?,
    val maxSpeechDurationMs: Int?,
    val provider: String,
    val numThreads: Int,
    val debug: Boolean,
  )

  fun parse(options: ReadableMap?): Parsed? {
    if (options == null) return null
    val core = InitModeModelPathsParser.parseCore(options) ?: return null

    val minSpeech = optionalInt(options, "minSpeechDurationMs")
      ?: optionalInt(options, "speechDurationMs")
      ?: 250
    val minSilence = optionalInt(options, "silenceDurationMs") ?: 250

    return Parsed(
      initMode = core.initMode,
      modelDir = core.modelDir,
      modelPaths = core.modelPaths,
      modelType = core.modelType?.trim()?.takeIf { it.isNotEmpty() } ?: "auto",
      sampleRate = optionalInt(options, "sampleRate") ?: 16000,
      threshold = optionalDouble(options, "threshold"),
      minSpeechDurationMs = minSpeech,
      minSilenceDurationMs = minSilence,
      windowSize = optionalInt(options, "windowSize"),
      maxSpeechDurationMs = optionalDouble(options, "maxSpeechDurationS")?.times(1000.0)?.toInt(),
      provider = optionalString(options, "provider") ?: "cpu",
      numThreads = optionalInt(options, "numThreads") ?: 1,
      debug = if (options.hasKey("debug")) options.getBoolean("debug") else false,
    )
  }

  private fun optionalDouble(options: ReadableMap, key: String): Double? =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key) else null

  private fun optionalInt(options: ReadableMap, key: String): Int? =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key).toInt() else null

  private fun optionalString(options: ReadableMap, key: String): String? =
    if (options.hasKey(key) && !options.isNull(key)) {
      options.getString(key)?.trim()?.takeIf { it.isNotEmpty() }
    } else {
      null
    }
}
