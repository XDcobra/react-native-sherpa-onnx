package com.sherpaonnx.tts.config

import com.facebook.react.bridge.ReadableMap

internal object TtsInitOptionsParser {
  fun modelDir(options: ReadableMap): String? = options.getString("modelDir")?.trim()?.takeIf { it.isNotEmpty() }

  fun modelType(options: ReadableMap): String = options.getString("modelType")?.trim()?.takeIf { it.isNotEmpty() } ?: "auto"

  fun numThreads(options: ReadableMap): Double =
    if (options.hasKey("numThreads")) options.getDouble("numThreads") else 2.0

  fun debug(options: ReadableMap): Boolean =
    if (options.hasKey("debug")) options.getBoolean("debug") else false

  fun optionalDouble(options: ReadableMap, key: String): Double? =
    if (options.hasKey(key)) options.getDouble(key) else null

  fun optionalString(options: ReadableMap, key: String): String? =
    if (options.hasKey(key)) options.getString(key)?.trim()?.takeIf { it.isNotEmpty() } else null

  fun lexiconLanguageId(options: ReadableMap): String? = optionalString(options, "lexiconLanguageId")

  /** Bridge-only: maps public `modelOptions.kokoro.lang`. */
  fun kokoroLang(options: ReadableMap): String? = optionalString(options, "kokoroLang")

  fun resolveLexiconPathFromDetect(
    lexiconLanguages: ArrayList<*>?,
    languageId: String?
  ): String? {
    if (lexiconLanguages.isNullOrEmpty()) return null
    val entries = lexiconLanguages.mapNotNull { item ->
      (item as? HashMap<*, *>)?.let { map ->
        val id = map["id"] as? String ?: return@mapNotNull null
        val path = map["path"] as? String ?: return@mapNotNull null
        id to path
      }
    }
    if (entries.isEmpty()) return null
    if (!languageId.isNullOrBlank()) {
      return entries.firstOrNull { it.first == languageId }?.second
    }
    return entries.first().second
  }
}
