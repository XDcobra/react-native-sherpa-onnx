package com.sherpaonnx

import android.content.Context
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineNemoEncDecCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OfflineZipformerCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWenetCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineFunAsrNanoModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineDolphinModelConfig
import com.k2fsa.sherpa.onnx.OfflineFireRedAsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineCanaryModelConfig
import com.k2fsa.sherpa.onnx.OfflineOmnilingualAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineMedAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File

internal class SherpaOnnxSttHelper(
  private val context: Context,
  private val detectSttModel: (
    modelDir: String,
    preferInt8: Boolean,
    hasPreferInt8: Boolean,
    modelType: String,
    debug: Boolean
  ) -> HashMap<String, Any>?,
  private val logTag: String
) {

  @Volatile
  private var recognizer: OfflineRecognizer? = null

  @Volatile
  private var lastRecognizerConfig: OfflineRecognizerConfig? = null

  /** Model type from last successful init; used to validate hotwords in setSttConfig. */
  @Volatile
  private var currentSttModelType: String? = null

  /** Hotwords are only supported for transducer models (sherpa-onnx limitation). */
  private fun supportsHotwords(modelType: String): Boolean =
    modelType == "transducer" || modelType == "nemo_transducer"

  /**
   * Resolves a single path to a file path. For content URIs (content://...) copies to app cache
   * so the native layer can read it; for file paths returns as-is.
   * Use for hotwords file or any single file path that may come from a document picker.
   * @param path File path or content URI
   * @param cacheFilePrefix Prefix for the cache file name (e.g. "stt_hotwords", "stt_rule_fst")
   * @return Resolved file path
   * @throws IllegalStateException if content URI cannot be opened
   */
  private fun resolveContentUriToFile(path: String, cacheFilePrefix: String): String {
    if (!path.startsWith("content://")) return path
    val uri = Uri.parse(path)
    val cacheFile = File(context.cacheDir, "${cacheFilePrefix}_${System.nanoTime()}")
    try {
      context.contentResolver.openInputStream(uri)?.use { input ->
        cacheFile.outputStream().use { output ->
          input.copyTo(output)
        }
      } ?: throw IllegalStateException("File is not readable (content URI could not be opened): $path")
    } catch (e: SecurityException) {
      throw IllegalStateException("File is not readable (no permission to read content URI): $path", e)
    } catch (e: Exception) {
      if (e is IllegalStateException) throw e
      throw IllegalStateException("File is not readable (content URI could not be opened): ${e.message ?: path}", e)
    }
    return cacheFile.absolutePath
  }

  /**
   * Resolves a string that may contain one or more paths (comma-separated). Each path may be
   * a content URI; each is resolved to a file path. Use for ruleFsts / ruleFars.
   * @param pathsString Single path or comma-separated paths (e.g. "path1,path2")
   * @param cacheFilePrefix Prefix for cache file names (e.g. "stt_rule_fst", "stt_rule_far")
   * @return Resolved paths joined by comma, or empty string if pathsString is blank
   */
  private fun resolveFilePaths(pathsString: String, cacheFilePrefix: String): String {
    if (pathsString.isBlank()) return pathsString
    return pathsString.split(',').map { it.trim() }.filter { it.isNotEmpty() }
      .mapIndexed { index, p -> resolveContentUriToFile(p, "${cacheFilePrefix}_$index") }
      .joinToString(",")
  }

  /** Resolves hotwords path (single file); delegates to [resolveContentUriToFile]. */
  private fun resolveHotwordsPath(path: String): String =
    resolveContentUriToFile(path, "stt_hotwords")

  /**
   * Validates hotwords file format (one hotword per line; optional " :score" at end).
   * Call after resolveHotwordsPath so path is always a file path (not content URI).
   * @return null if valid, or an error message if invalid.
   */
  private fun validateHotwordsFile(filePath: String): String? {
    val file = File(filePath)
    if (!file.exists()) return "Hotwords file does not exist: $filePath"
    if (!file.isFile) return "Hotwords path is not a file: $filePath"
    if (!file.canRead()) return "Hotwords file is not readable: $filePath"
    val content = try {
      file.readText(Charsets.UTF_8)
    } catch (e: Exception) {
      return "Failed to read hotwords file: ${e.message}"
    }
    if (content.contains('\u0000')) return "Hotwords file contains null bytes (not a valid text file)."
    val lines = content.split('\n', '\r')
    var validLines = 0
    for (raw in lines) {
      val line = raw.trim()
      if (line.isEmpty()) continue
      if (line.contains(" :")) {
        val lastColon = line.lastIndexOf(" :")
        val afterScore = line.substring(lastColon + 2).trim()
        if (afterScore.isEmpty()) return "Invalid hotword line (missing score after ' :'): ${line.take(60)}…"
        val score = afterScore.toFloatOrNull()
        if (score == null) return "Invalid hotword line (score must be a number after ' :'): ${line.take(60)}…"
      }
      validLines++
    }
    if (validLines == 0) return "Hotwords file has no valid lines (one hotword or phrase per line, UTF-8 text)."
    return null
  }

  fun initializeStt(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    debug: Boolean?,
    hotwordsFile: String?,
    hotwordsScore: Double?,
    numThreads: Double?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Double?,
    modelOptions: ReadableMap?,
    promise: Promise
  ) {
    try {
      CrashlyticsHelper.setContextAttributes(
        modelDir = modelDir,
        modelType = modelType,
        feature = "stt",
        preferInt8 = preferInt8,
        sttNumThreads = numThreads?.toInt(),
        sttHotwordsFile = hotwordsFile?.trim()?.takeIf { it.isNotEmpty() },
        sttHotwordsScore = hotwordsScore?.toFloat(),
        sttProvider = provider?.takeIf { it.isNotBlank() },
        sttRuleFsts = ruleFsts?.takeIf { it.isNotBlank() },
        sttRuleFars = ruleFars?.takeIf { it.isNotBlank() },
        sttDither = dither?.toFloat(),
        sttModelOptionsSummary = modelOptionsSummary(modelOptions)
      )
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        val errorMsg = "Model directory does not exist: $modelDir"
        Log.e(logTag, errorMsg)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
        return
      }

      if (!modelDirFile.isDirectory) {
        val errorMsg = "Model path is not a directory: $modelDir"
        Log.e(logTag, errorMsg)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
        return
      }

      val result = detectSttModel(
        modelDir,
        preferInt8 ?: false,
        preferInt8 != null,
        modelType ?: "auto",
        debug ?: false
      )

      if (result == null) {
        val errorMsg = "Failed to detect STT model. Check native logs for details."
        Log.e(logTag, "Detection returned null for modelDir: $modelDir")
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
        return
      }

      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()

      if (!success) {
        val reason = result["error"] as? String
        val errorMsg = if (!reason.isNullOrBlank()) {
          "Failed to initialize sherpa-onnx: $reason"
        } else {
          "Failed to initialize sherpa-onnx. Check native logs for details."
        }
        Log.e(logTag, "Detection failed for modelDir: $modelDir")
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
        return
      }

      val paths = result["paths"] as? Map<*, *> ?: emptyMap<String, String>()
      val pathStrings = paths.mapValues { (_, v) -> (v as? String).orEmpty() }.mapKeys { it.key.toString() }
      val modelTypeStr = result["modelType"] as? String ?: "unknown"

      val hotwordsFileTrimmed = hotwordsFile?.trim().orEmpty()
      if (hotwordsFileTrimmed.isNotEmpty() && !supportsHotwords(modelTypeStr)) {
        val errorMsg = "Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type: $modelTypeStr"
        Log.e(logTag, errorMsg)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "HOTWORDS_NOT_SUPPORTED", errorMsg, feature = "stt")
        return
      }
      val resolvedHotwordsPath = if (hotwordsFileTrimmed.isNotEmpty()) {
        try {
          resolveHotwordsPath(hotwordsFileTrimmed)
        } catch (e: Exception) {
          val errorMsg = e.message ?: "Hotwords file could not be resolved"
          Log.e(logTag, errorMsg, e)
          CrashlyticsHelper.rejectWithCrashlytics(promise, "INVALID_HOTWORDS_FILE", errorMsg, e, feature = "stt")
          return
        }
      } else ""
      if (resolvedHotwordsPath.isNotEmpty()) {
        validateHotwordsFile(resolvedHotwordsPath)?.let { errorMsg ->
          Log.e(logTag, errorMsg)
          CrashlyticsHelper.rejectWithCrashlytics(promise, "INVALID_HOTWORDS_FILE", errorMsg, feature = "stt")
          return
        }
      }

      val resolvedRuleFsts = try {
        resolveFilePaths(ruleFsts.orEmpty().trim(), "stt_rule_fst")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FST path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, e, feature = "stt")
        return
      }
      val resolvedRuleFars = try {
        resolveFilePaths(ruleFars.orEmpty().trim(), "stt_rule_far")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FAR path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, e, feature = "stt")
        return
      }

      recognizer?.release()
      recognizer = null
      val config = buildRecognizerConfig(
        pathStrings,
        modelTypeStr,
        hotwordsFile = resolvedHotwordsPath,
        hotwordsScore = hotwordsScore?.toFloat() ?: 1.5f,
        numThreads = numThreads?.toInt(),
        provider = provider,
        ruleFsts = resolvedRuleFsts,
        ruleFars = resolvedRuleFars,
        dither = dither?.toFloat() ?: 0f,
        modelOptions = modelOptions
      )
      lastRecognizerConfig = config
      currentSttModelType = modelTypeStr
      recognizer = OfflineRecognizer(config = config)

      CrashlyticsHelper.setContextAttributes(
        modelDir = modelDir,
        modelType = modelTypeStr,
        feature = "stt",
        preferInt8 = preferInt8,
        sttNumThreads = config.modelConfig.numThreads,
        sttHotwordsFile = config.hotwordsFile.takeIf { it.isNotBlank() },
        sttHotwordsScore = config.hotwordsScore,
        sttProvider = config.modelConfig.provider.takeIf { it.isNotBlank() },
        sttRuleFsts = config.ruleFsts.takeIf { it.isNotBlank() },
        sttRuleFars = config.ruleFars.takeIf { it.isNotBlank() },
        sttDither = config.featConfig.dither,
        sttDecodingMethod = config.decodingMethod,
        sttMaxActivePaths = config.maxActivePaths,
        sttModelOptionsSummary = modelOptionsSummary(modelOptions)
      )

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putString("modelType", modelTypeStr)
      val detectedModelsArray = Arguments.createArray()
      for (model in detectedModels) {
        val modelMap = model as? HashMap<*, *>
        if (modelMap != null) {
          val modelResultMap = Arguments.createMap()
          modelResultMap.putString("type", modelMap["type"] as? String ?: "")
          modelResultMap.putString("modelDir", modelMap["modelDir"] as? String ?: "")
          detectedModelsArray.pushMap(modelResultMap)
        }
      }
      resultMap.putArray("detectedModels", detectedModelsArray)
      promise.resolve(resultMap)
    } catch (e: Exception) {
      val errorMsg = "Exception during initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMsg, e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, e, "stt")
    }
  }

  fun transcribeFile(filePath: String, promise: Promise) {
    try {
      val rec = recognizer
      if (rec == null) {
        CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", "STT not initialized. Call initializeStt first.", feature = "stt")
        return
      }
      val wave = WaveReader.readWave(filePath)
      val stream: OfflineStream = rec.createStream()
      stream.acceptWaveform(wave.samples, wave.sampleRate)
      rec.decode(stream)
      val result = rec.getResult(stream)
      promise.resolve(resultToWritableMap(result))
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe file"
      Log.e(logTag, "transcribeFile error: $message", e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", message, e, "stt")
    }
  }

  fun transcribeSamples(samples: com.facebook.react.bridge.ReadableArray, sampleRate: Int, promise: Promise) {
    try {
      val rec = recognizer
      if (rec == null) {
        CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", "STT not initialized. Call initializeStt first.", feature = "stt")
        return
      }
      val floatSamples = FloatArray(samples.size()) { i -> samples.getDouble(i).toFloat() }
      val stream: OfflineStream = rec.createStream()
      try {
        stream.acceptWaveform(floatSamples, sampleRate)
        rec.decode(stream)
        val result = rec.getResult(stream)
        promise.resolve(resultToWritableMap(result))
      } finally {
        stream.release()
      }
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe samples"
      Log.e(logTag, "transcribeSamples error: $message", e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", message, e, "stt")
    }
  }

  fun setSttConfig(options: ReadableMap, promise: Promise) {
    try {
      val rec = recognizer
      val current = lastRecognizerConfig
      if (rec == null || current == null) {
        CrashlyticsHelper.rejectWithCrashlytics(promise, "CONFIG_ERROR", "STT not initialized. Call initializeStt first.", feature = "stt")
        return
      }
      val merged = current.copy(
        decodingMethod = if (options.hasKey("decodingMethod")) options.getString("decodingMethod") ?: current.decodingMethod else current.decodingMethod,
        maxActivePaths = if (options.hasKey("maxActivePaths")) options.getDouble("maxActivePaths").toInt() else current.maxActivePaths,
        hotwordsFile = if (options.hasKey("hotwordsFile")) options.getString("hotwordsFile") ?: current.hotwordsFile else current.hotwordsFile,
        hotwordsScore = if (options.hasKey("hotwordsScore")) options.getDouble("hotwordsScore").toFloat() else current.hotwordsScore,
        blankPenalty = if (options.hasKey("blankPenalty")) options.getDouble("blankPenalty").toFloat() else current.blankPenalty,
        ruleFsts = if (options.hasKey("ruleFsts")) options.getString("ruleFsts") ?: current.ruleFsts else current.ruleFsts,
        ruleFars = if (options.hasKey("ruleFars")) options.getString("ruleFars") ?: current.ruleFars else current.ruleFars
      )
      val resolvedRuleFsts = try {
        resolveFilePaths(merged.ruleFsts.trim(), "stt_rule_fst")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FST path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "CONFIG_ERROR", errorMsg, e, feature = "stt")
        return
      }
      val resolvedRuleFars = try {
        resolveFilePaths(merged.ruleFars.trim(), "stt_rule_far")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FAR path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "CONFIG_ERROR", errorMsg, e, feature = "stt")
        return
      }

      val newHotwordsFile = merged.hotwordsFile.trim()
      val resolvedHotwordsPath = if (newHotwordsFile.isNotEmpty()) {
        val modelType = currentSttModelType
        if (modelType == null || !supportsHotwords(modelType)) {
          val errorMsg = "Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type: ${modelType ?: "unknown"}"
          Log.e(logTag, errorMsg)
          CrashlyticsHelper.rejectWithCrashlytics(promise, "HOTWORDS_NOT_SUPPORTED", errorMsg, feature = "stt")
          return
        }
        try {
          resolveHotwordsPath(newHotwordsFile)
        } catch (e: Exception) {
          val errorMsg = e.message ?: "Hotwords file could not be resolved"
          Log.e(logTag, errorMsg, e)
          CrashlyticsHelper.rejectWithCrashlytics(promise, "INVALID_HOTWORDS_FILE", errorMsg, e, feature = "stt")
          return
        }.also { path ->
          validateHotwordsFile(path)?.let { errorMsg ->
            Log.e(logTag, errorMsg)
            CrashlyticsHelper.rejectWithCrashlytics(promise, "INVALID_HOTWORDS_FILE", errorMsg, feature = "stt")
            return
          }
        }
      } else ""
      val configToApply = merged.copy(
        hotwordsFile = resolvedHotwordsPath,
        ruleFsts = resolvedRuleFsts,
        ruleFars = resolvedRuleFars
      )
      lastRecognizerConfig = configToApply
      rec.setConfig(configToApply)
      CrashlyticsHelper.setContextAttributes(
        feature = "stt",
        modelType = currentSttModelType,
        modelDir = null,
        preferInt8 = null,
        sttDecodingMethod = configToApply.decodingMethod,
        sttMaxActivePaths = configToApply.maxActivePaths,
        sttHotwordsFile = configToApply.hotwordsFile.takeIf { it.isNotBlank() },
        sttHotwordsScore = configToApply.hotwordsScore
      )
      promise.resolve(null)
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to set STT config"
      Log.e(logTag, "setSttConfig error: $message", e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "CONFIG_ERROR", message, e, "stt")
    }
  }

  private fun resultToWritableMap(result: OfflineRecognizerResult): WritableMap {
    val map = Arguments.createMap()
    map.putString("text", result.text)
    val tokensArray = Arguments.createArray()
    for (t in result.tokens) tokensArray.pushString(t)
    map.putArray("tokens", tokensArray)
    val timestampsArray = Arguments.createArray()
    for (t in result.timestamps) timestampsArray.pushDouble(t.toDouble())
    map.putArray("timestamps", timestampsArray)
    map.putString("lang", result.lang)
    map.putString("emotion", result.emotion)
    map.putString("event", result.event)
    val durationsArray = Arguments.createArray()
    for (d in result.durations) durationsArray.pushDouble(d.toDouble())
    map.putArray("durations", durationsArray)
    return map
  }

  fun unloadStt(promise: Promise) {
    try {
      recognizer?.release()
      recognizer = null
      lastRecognizerConfig = null
      currentSttModelType = null
      promise.resolve(null)
    } catch (e: Exception) {
      CrashlyticsHelper.rejectWithCrashlytics(promise, "RELEASE_ERROR", "Failed to release resources", e, "stt")
    }
  }

  private fun path(paths: Map<String, String>, key: String): String =
    paths[key].orEmpty()

  /** Builds a short summary of modelOptions for Crashlytics (max ~200 chars). */
  private fun modelOptionsSummary(modelOptions: ReadableMap?): String {
    if (modelOptions == null) return ""
    val parts = mutableListOf<String>()
    modelOptions.getMap("whisper")?.let { w ->
      val lang = w.getString("language") ?: ""
      val task = w.getString("task") ?: ""
      parts.add("whisper:lang=$lang,task=$task")
    }
    modelOptions.getMap("senseVoice")?.let { sv ->
      val lang = sv.getString("language") ?: ""
      val itn = if (sv.hasKey("useItn")) sv.getBoolean("useItn") else null
      parts.add("senseVoice:lang=$lang" + (itn?.let { ",itn=$it" } ?: ""))
    }
    modelOptions.getMap("canary")?.let { c ->
      val src = c.getString("srcLang") ?: ""
      val tgt = c.getString("tgtLang") ?: ""
      parts.add("canary:src=$src,tgt=$tgt")
    }
    modelOptions.getMap("funasrNano")?.let { fn ->
      val lang = fn.getString("language") ?: ""
      val hasHotwords = fn.hasKey("hotwords") && fn.getString("hotwords")?.isNotBlank() == true
      parts.add("funasrNano:lang=$lang,hotwords=$hasHotwords")
    }
    return parts.joinToString(";").take(200)
  }

  private fun buildRecognizerConfig(
    paths: Map<String, String>,
    modelType: String,
    hotwordsFile: String = "",
    hotwordsScore: Float = 1.5f,
    numThreads: Int? = null,
    provider: String? = null,
    ruleFsts: String = "",
    ruleFars: String = "",
    dither: Float = 0f,
    modelOptions: ReadableMap? = null
  ): OfflineRecognizerConfig {
    val featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80, dither = dither)
    val modelConfig = when (modelType) {
      "transducer", "nemo_transducer" -> OfflineModelConfig(
        transducer = OfflineTransducerModelConfig(
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          joiner = path(paths, "joiner")
        ),
        tokens = path(paths, "tokens"),
        modelType = modelType
      )
      "paraformer" -> OfflineModelConfig(
        paraformer = OfflineParaformerModelConfig(model = path(paths, "paraformerModel")),
        tokens = path(paths, "tokens"),
        modelType = "paraformer"
      )
      "nemo_ctc" -> OfflineModelConfig(
        nemo = OfflineNemoEncDecCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = "nemo_ctc"
      )
      "wenet_ctc" -> OfflineModelConfig(
        wenetCtc = com.k2fsa.sherpa.onnx.OfflineWenetCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = "wenet_ctc"
      )
      "sense_voice" -> {
        val sv = modelOptions?.getMap("senseVoice")
        OfflineModelConfig(
          senseVoice = OfflineSenseVoiceModelConfig(
            model = path(paths, "ctcModel"),
            language = sv?.getString("language") ?: "",
            useInverseTextNormalization = if (sv?.hasKey("useItn") == true) sv.getBoolean("useItn") else true
          ),
          tokens = path(paths, "tokens"),
          modelType = "sense_voice"
        )
      }
      "zipformer_ctc", "ctc" -> OfflineModelConfig(
        zipformerCtc = OfflineZipformerCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = if (modelType == "ctc") "zipformer_ctc" else modelType
      )
      "whisper" -> {
        val w = modelOptions?.getMap("whisper")
        OfflineModelConfig(
          whisper = OfflineWhisperModelConfig(
            encoder = path(paths, "whisperEncoder"),
            decoder = path(paths, "whisperDecoder"),
            language = w?.getString("language") ?: "en",
            task = w?.getString("task") ?: "transcribe",
            tailPaddings = if (w?.hasKey("tailPaddings") == true) w.getInt("tailPaddings") else 1000,
            enableTokenTimestamps = w?.hasKey("enableTokenTimestamps") == true && w.getBoolean("enableTokenTimestamps"),
            enableSegmentTimestamps = w?.hasKey("enableSegmentTimestamps") == true && w.getBoolean("enableSegmentTimestamps")
          ),
          tokens = path(paths, "tokens"),
          modelType = "whisper"
        )
      }
      "fire_red_asr" -> OfflineModelConfig(
        fireRedAsr = OfflineFireRedAsrModelConfig(
          encoder = path(paths, "fireRedEncoder"),
          decoder = path(paths, "fireRedDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "fire_red_asr"
      )
      "moonshine" -> OfflineModelConfig(
        moonshine = OfflineMoonshineModelConfig(
          preprocessor = path(paths, "moonshinePreprocessor"),
          encoder = path(paths, "moonshineEncoder"),
          uncachedDecoder = path(paths, "moonshineUncachedDecoder"),
          cachedDecoder = path(paths, "moonshineCachedDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "moonshine"
      )
      "dolphin" -> OfflineModelConfig(
        dolphin = OfflineDolphinModelConfig(model = path(paths, "dolphinModel")),
        tokens = path(paths, "tokens"),
        modelType = "dolphin"
      )
      "canary" -> {
        val c = modelOptions?.getMap("canary")
        OfflineModelConfig(
          canary = OfflineCanaryModelConfig(
            encoder = path(paths, "canaryEncoder"),
            decoder = path(paths, "canaryDecoder"),
            srcLang = c?.getString("srcLang") ?: "en",
            tgtLang = c?.getString("tgtLang") ?: "en",
            usePnc = if (c?.hasKey("usePnc") == true) c.getBoolean("usePnc") else true
          ),
          tokens = path(paths, "tokens"),
          modelType = "canary"
        )
      }
      "omnilingual" -> OfflineModelConfig(
        omnilingual = OfflineOmnilingualAsrCtcModelConfig(model = path(paths, "omnilingualModel")),
        tokens = path(paths, "tokens"),
        modelType = "omnilingual"
      )
      "medasr" -> OfflineModelConfig(
        medasr = OfflineMedAsrCtcModelConfig(model = path(paths, "medasrModel")),
        tokens = path(paths, "tokens"),
        modelType = "medasr"
      )
      "telespeech_ctc" -> OfflineModelConfig(
        teleSpeech = path(paths, "telespeechCtcModel"),
        tokens = path(paths, "tokens"),
        modelType = "telespeech_ctc"
      )
      "funasr_nano" -> {
        val fn = modelOptions?.getMap("funasrNano")
        OfflineModelConfig(
          funasrNano = OfflineFunAsrNanoModelConfig(
            encoderAdaptor = path(paths, "funasrEncoderAdaptor"),
            llm = path(paths, "funasrLLM"),
            embedding = path(paths, "funasrEmbedding"),
            tokenizer = path(paths, "funasrTokenizer"),
            systemPrompt = fn?.getString("systemPrompt") ?: "You are a helpful assistant.",
            userPrompt = fn?.getString("userPrompt") ?: "语音转写：",
            maxNewTokens = if (fn?.hasKey("maxNewTokens") == true) fn.getInt("maxNewTokens") else 512,
            temperature = if (fn?.hasKey("temperature") == true) fn.getDouble("temperature").toFloat() else 1e-6f,
            topP = if (fn?.hasKey("topP") == true) fn.getDouble("topP").toFloat() else 0.8f,
            seed = if (fn?.hasKey("seed") == true) fn.getInt("seed") else 42,
            language = fn?.getString("language") ?: "",
            itn = if (fn?.hasKey("itn") == true) fn.getBoolean("itn") else true,
            hotwords = fn?.getString("hotwords") ?: ""
          ),
          tokens = ""
        )
      }
      else -> {
        val tokens = path(paths, "tokens")
        when {
          path(paths, "encoder").isNotEmpty() -> OfflineModelConfig(
            transducer = OfflineTransducerModelConfig(
              encoder = path(paths, "encoder"),
              decoder = path(paths, "decoder"),
              joiner = path(paths, "joiner")
            ),
            tokens = tokens,
            modelType = "transducer"
          )
          path(paths, "paraformerModel").isNotEmpty() -> OfflineModelConfig(
            paraformer = OfflineParaformerModelConfig(model = path(paths, "paraformerModel")),
            tokens = tokens,
            modelType = "paraformer"
          )
          path(paths, "ctcModel").isNotEmpty() -> OfflineModelConfig(
            zipformerCtc = OfflineZipformerCtcModelConfig(model = path(paths, "ctcModel")),
            tokens = tokens,
            modelType = modelType
          )
          else -> OfflineModelConfig(tokens = tokens, modelType = modelType)
        }
      }
    }
    val finalModelConfig = modelConfig.copy(
      numThreads = numThreads ?: 1,
      provider = provider ?: "cpu"
    )
    return OfflineRecognizerConfig(
      featConfig = featConfig,
      modelConfig = finalModelConfig,
      hotwordsFile = hotwordsFile,
      hotwordsScore = hotwordsScore,
      ruleFsts = ruleFsts,
      ruleFars = ruleFars
    )
  }
}
