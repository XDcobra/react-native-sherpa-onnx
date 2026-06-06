package com.sherpaonnx.tts.config

import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.bridge.InitModeModelPathsParser

/** Parse `initializeTts(instanceId, options)` TurboModule map. */
internal object TtsInitOptionsParser {
  data class Parsed(
    val initMode: String,
    val modelDir: String?,
    val modelPaths: Map<String, String>?,
    val modelType: String,
    val numThreads: Double,
    val debug: Boolean,
    val noiseScale: Double?,
    val noiseScaleW: Double?,
    val lengthScale: Double?,
    val ruleFsts: String?,
    val ruleFars: String?,
    val maxNumSentences: Double?,
    val silenceScale: Double?,
    val provider: String?,
    val lexiconLanguageId: String?,
    val kokoroLang: String?,
  )

  fun parse(options: ReadableMap): Parsed? {
    val core = InitModeModelPathsParser.parseCore(options) ?: return null

    return Parsed(
      initMode = core.initMode,
      modelDir = core.modelDir,
      modelPaths = core.modelPaths,
      modelType = core.modelType?.trim()?.takeIf { it.isNotEmpty() } ?: "auto",
      numThreads = if (options.hasKey("numThreads")) options.getDouble("numThreads") else 2.0,
      debug = if (options.hasKey("debug")) options.getBoolean("debug") else false,
      noiseScale = optionalDouble(options, "noiseScale"),
      noiseScaleW = optionalDouble(options, "noiseScaleW"),
      lengthScale = optionalDouble(options, "lengthScale"),
      ruleFsts = optionalString(options, "ruleFsts"),
      ruleFars = optionalString(options, "ruleFars"),
      maxNumSentences = optionalDouble(options, "maxNumSentences"),
      silenceScale = optionalDouble(options, "silenceScale"),
      provider = optionalString(options, "provider"),
      lexiconLanguageId = optionalString(options, "lexiconLanguageId"),
      kokoroLang = optionalString(options, "kokoroLang"),
    )
  }

  fun optionalDouble(options: ReadableMap, key: String): Double? =
    if (options.hasKey(key)) options.getDouble(key) else null

  fun optionalString(options: ReadableMap, key: String): String? =
    if (options.hasKey(key)) options.getString(key)?.trim()?.takeIf { it.isNotEmpty() } else null

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
