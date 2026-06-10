package com.sherpaonnx.bridge

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType

/** Shared initMode / modelDir / modelPaths parsing for TurboModule init bridges. */
internal object InitModeModelPathsParser {
  data class Core(
    val initMode: String,
    val modelDir: String?,
    val modelPaths: Map<String, String>?,
    val modelType: String?,
  )

  fun parseCore(
    options: ReadableMap,
    requireModelTypeForCustom: Boolean = true,
  ): Core? {
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

    val modelType = if (options.hasKey("modelType") && !options.isNull("modelType")) {
      options.getString("modelType")?.trim()?.takeIf { it.isNotEmpty() }
    } else {
      null
    }

    if (initMode == "custom") {
      if (modelPaths.isNullOrEmpty()) return null
      if (requireModelTypeForCustom && modelType.isNullOrEmpty()) return null
    } else if (modelDir.isNullOrEmpty()) {
      return null
    }

    return Core(
      initMode = initMode,
      modelDir = modelDir,
      modelPaths = modelPaths,
      modelType = modelType,
    )
  }

  fun readStringMap(map: ReadableMap?): Map<String, String>? {
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
