package com.sherpaonnx.stt.config

import com.facebook.react.bridge.ReadableMap

/** Parse `initializeStt(instanceId, options)` TurboModule map. */
internal object SttInitOptionsParser {
  data class Parsed(
    val modelDir: String,
    val preferInt8: Boolean?,
    val modelType: String?,
    val debug: Boolean?,
    val hotwordsFile: String?,
    val hotwordsScore: Double?,
    val numThreads: Double?,
    val provider: String?,
    val ruleFsts: String?,
    val ruleFars: String?,
    val dither: Double?,
    val modelOptions: ReadableMap?,
    val modelingUnit: String?,
    val bpeVocab: String?,
  )

  fun parse(options: ReadableMap): Parsed? {
    val modelDir = options.getString("modelDir")?.trim().orEmpty()
    if (modelDir.isEmpty()) return null
    return Parsed(
      modelDir = modelDir,
      preferInt8 = if (options.hasKey("preferInt8")) options.getBoolean("preferInt8") else null,
      modelType = if (options.hasKey("modelType")) options.getString("modelType") else null,
      debug = if (options.hasKey("debug")) options.getBoolean("debug") else null,
      hotwordsFile = if (options.hasKey("hotwordsFile")) options.getString("hotwordsFile") else null,
      hotwordsScore = if (options.hasKey("hotwordsScore")) options.getDouble("hotwordsScore") else null,
      numThreads = if (options.hasKey("numThreads")) options.getDouble("numThreads") else null,
      provider = if (options.hasKey("provider")) options.getString("provider") else null,
      ruleFsts = if (options.hasKey("ruleFsts")) options.getString("ruleFsts") else null,
      ruleFars = if (options.hasKey("ruleFars")) options.getString("ruleFars") else null,
      dither = if (options.hasKey("dither")) options.getDouble("dither") else null,
      modelOptions =
        if (options.hasKey("modelOptions") && !options.isNull("modelOptions")) {
          options.getMap("modelOptions")
        } else {
          null
        },
      modelingUnit = if (options.hasKey("modelingUnit")) options.getString("modelingUnit") else null,
      bpeVocab = if (options.hasKey("bpeVocab")) options.getString("bpeVocab") else null,
    )
  }
}
