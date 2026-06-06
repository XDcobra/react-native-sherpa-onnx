package com.sherpaonnx.stt.config

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType

/** Parse `initializeStt(instanceId, options)` TurboModule map. */
internal object SttInitOptionsParser {
  data class Parsed(
    val initMode: String,
    val modelDir: String?,
    val modelPaths: Map<String, String>?,
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
    val initMode = if (options.hasKey("initMode")) {
      options.getString("initMode")?.trim().orEmpty().ifEmpty { "auto" }
    } else {
      "auto"
    }

    val modelDir = if (options.hasKey("modelDir")) {
      options.getString("modelDir")?.trim()?.takeIf { it.isNotEmpty() }
    } else {
      null
    }

    val modelPaths = if (options.hasKey("modelPaths") && !options.isNull("modelPaths")) {
      readStringMap(options.getMap("modelPaths"))
    } else {
      null
    }

    if (initMode == "custom") {
      if (modelPaths.isNullOrEmpty()) {
        return null
      }
      if (!options.hasKey("modelType") || options.isNull("modelType")) {
        return null
      }
    } else if (modelDir.isNullOrEmpty()) {
      return null
    }

    return Parsed(
      initMode = initMode,
      modelDir = modelDir,
      modelPaths = modelPaths,
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

  private fun readStringMap(map: ReadableMap?): Map<String, String>? {
    if (map == null) return null
    val out = linkedMapOf<String, String>()
    val iterator = map.keySetIterator()
    while (iterator.hasNextKey()) {
      val key = iterator.nextKey()
      if (map.getType(key) != ReadableType.String) continue
      val value = map.getString(key)?.trim().orEmpty()
      if (value.isNotEmpty()) {
        out[key] = value
      }
    }
    return out
  }
}
