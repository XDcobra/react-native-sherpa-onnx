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
    val quantization: String?,
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
      quantization = optionalString(options, "quantization"),
    )
  }

  fun optionalDouble(options: ReadableMap, key: String): Double? =
    if (options.hasKey(key)) options.getDouble(key) else null

  fun optionalString(options: ReadableMap, key: String): String? =
    if (options.hasKey(key)) options.getString(key)?.trim()?.takeIf { it.isNotEmpty() } else null

  /**
   * All detected lexicon paths joined with ',' (upstream's multi-lexicon form), in detect
   * order; null when none. Used for ZipVoice, which loads every lexicon (zh + en).
   */
  fun joinAllLexiconPathsFromDetect(lexiconLanguages: ArrayList<*>?): String? {
    if (lexiconLanguages.isNullOrEmpty()) return null
    val paths = lexiconLanguages.mapNotNull { item ->
      ((item as? HashMap<*, *>)?.get("path") as? String)?.takeIf { it.isNotBlank() }
    }
    return paths.takeIf { it.isNotEmpty() }?.joinToString(",")
  }

  /** Init error code: the model needs a lexicon file its directory lacks. */
  const val LEXICON_MISSING_CODE = "TTS_LEXICON_MISSING"

  /** Upstream's English lexicon, published next to the packs that need it. */
  private const val ENGLISH_LEXICON_FILE = "lexicon-en-us.txt"

  /** Lexicon language id (from lexicon-<id>.txt) that names English: en, en-us, us-en, gb-en. */
  fun isEnglishLexiconLanguageId(languageId: String): Boolean {
    val id = languageId.lowercase()
    if (id == "en") return true
    if (id.length > 3 && id.startsWith("en") && (id[2] == '-' || id[2] == '_')) return true
    val n = id.length
    return n > 3 && id.endsWith("en") && (id[n - 3] == '-' || id[n - 3] == '_')
  }

  /**
   * Lexicon file auto init must refuse to start without, or null. Mirrors
   * MissingTtsLexiconFile in sherpa-onnx-tts-lexicon.h: ZipVoice skips every word that is
   * in none of its lexicons without an error, so with lexicons but no English one English
   * text is lost. No lexicon at all is left alone (upstream fails on text; tokens still
   * work). An explicit [languageId] is the caller's pick and is not second-guessed.
   */
  fun missingLexiconFile(
    modelType: String,
    lexiconLanguages: ArrayList<*>?,
    languageId: String?
  ): String? {
    if (modelType != "zipvoice" || !languageId.isNullOrBlank() || lexiconLanguages.isNullOrEmpty()) {
      return null
    }
    val hasEnglish = lexiconLanguages.any { item ->
      ((item as? HashMap<*, *>)?.get("id") as? String)?.let { isEnglishLexiconLanguageId(it) } == true
    }
    return if (hasEnglish) null else ENGLISH_LEXICON_FILE
  }

  /** Message for [LEXICON_MISSING_CODE]; starts with the code (same text as on iOS). */
  fun lexiconMissingMessage(fileName: String): String =
    "$LEXICON_MISSING_CODE: ZipVoice needs an English lexicon ($fileName) in the model directory; " +
      "without it every English word is skipped. ensureModel() downloads it for catalog models, " +
      "or add the upstream file next to lexicon.txt. Set lexiconLanguageId to load only the lexicon you pick."

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
