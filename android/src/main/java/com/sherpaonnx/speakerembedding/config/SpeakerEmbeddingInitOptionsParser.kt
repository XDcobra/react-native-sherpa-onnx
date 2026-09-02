package com.sherpaonnx.speakerembedding.config

import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.bridge.InitModeModelPathsParser

/** Parse `initializeSpeakerEmbeddingExtractor` TurboModule maps. */
internal object SpeakerEmbeddingInitOptionsParser {
  data class Parsed(
    val initMode: String,
    val modelDir: String?,
    val modelPaths: Map<String, String>?,
    val modelType: String,
    val numThreads: Double,
    val provider: String?,
    val debug: Boolean,
  )

  fun parse(options: ReadableMap?): Parsed? {
    if (options == null) return null
    val core = InitModeModelPathsParser.parseCore(options) ?: return null

    return Parsed(
      initMode = core.initMode,
      modelDir = core.modelDir,
      modelPaths = core.modelPaths,
      modelType = core.modelType?.trim()?.takeIf { it.isNotEmpty() } ?: "auto",
      numThreads = if (options.hasKey("numThreads")) options.getDouble("numThreads") else 1.0,
      provider = optionalString(options, "provider"),
      debug = if (options.hasKey("debug")) options.getBoolean("debug") else false,
    )
  }

  private fun optionalString(options: ReadableMap, key: String): String? =
    if (options.hasKey(key) && !options.isNull(key)) {
      options.getString(key)?.trim()?.takeIf { it.isNotEmpty() }
    } else {
      null
    }
}
