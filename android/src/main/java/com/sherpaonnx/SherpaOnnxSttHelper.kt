package com.sherpaonnx

import android.content.Context
import android.net.Uri
import android.os.HandlerThread
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineNemoEncDecCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OfflineZipformerCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWenetCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineFunAsrNanoModelConfig
import com.k2fsa.sherpa.onnx.OfflineQwen3AsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineCohereTranscribeModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineDolphinModelConfig
import com.k2fsa.sherpa.onnx.OfflineFireRedAsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineCanaryModelConfig
import com.k2fsa.sherpa.onnx.OfflineOmnilingualAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineMedAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.WaveReader
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.stt.SttErrorCodes
import com.sherpaonnx.stt.SttRetainedResult
import com.sherpaonnx.stt.SttResultSlot
import java.io.File
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxSttHelper(
  private val context: Context,
  private val detectSttModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
    preferInt8: Boolean,
    hasPreferInt8: Boolean,
    debug: Boolean
  ) -> HashMap<String, Any>?,
  private val logTag: String
) {

  private data class SttEngineInstance(
    @Volatile var recognizer: OfflineRecognizer? = null,
    @Volatile var lastRecognizerConfig: OfflineRecognizerConfig? = null,
    @Volatile var currentSttModelType: String? = null,
    @Volatile var qwen3HotwordsForStream: String = "",
    val resultSlot: SttResultSlot = SttResultSlot()
  )

  private val instances = ConcurrentHashMap<String, SttEngineInstance>()

  private val initThread = HandlerThread("stt-init").also { it.start() }
  private val initHandler = android.os.Handler(initThread.looper)

  private fun getInstance(instanceId: String): SttEngineInstance? = instances[instanceId]

  /** Hotwords are supported for transducer and NeMo transducer models (sherpa-onnx; NeMo: https://github.com/k2-fsa/sherpa-onnx/pull/3077). */
  private fun supportsHotwords(modelType: String): Boolean =
    modelType == "transducer" || modelType == "nemo_transducer"

  /** Normalizes Qwen3-ASR hotwords to a comma-separated string for stream option "hotwords". */
  private fun normalizeQwen3HotwordsCsv(raw: String): String {
    if (raw.isEmpty()) return ""
    // Match iOS: treat \r and \n as phrase separators (then comma-split).
    val flat = raw.replace('\r', '\n').replace('\n', ',')
    return flat.split(',')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .joinToString(",")
  }

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
      val hotwordPart = if (line.contains(" :")) {
        val lastColon = line.lastIndexOf(" :")
        val afterScore = line.substring(lastColon + 2).trim()
        if (afterScore.isEmpty()) return "Invalid hotword line (missing score after ' :'): ${line.take(60)}…"
        val score = afterScore.toFloatOrNull()
        if (score == null) return "Invalid hotword line (score must be a number after ' :'): ${line.take(60)}…"
        line.substring(0, lastColon).trim()
      } else if (line.contains('\t')) {
        // Likely sentencepiece .vocab format (token<TAB>score); hotwords use " :score" and one word/phrase per line.
        val afterTab = line.substringAfter('\t').trim()
        if (afterTab.toFloatOrNull() != null) {
          return "This file looks like a sentencepiece .vocab file (token<TAB>score). Use a hotwords file instead: one word or phrase per line, optional ' :score' at end."
        }
        line
      } else line
      if (hotwordPart.isEmpty()) return "Invalid hotword line (empty hotword): ${line.take(60)}…"
      if (!hotwordPart.any { it.isLetter() }) return "Invalid hotword line (must contain at least one letter): ${line.take(60)}…"
      validLines++
    }
    if (validLines == 0) return "Hotwords file has no valid lines (one hotword or phrase per line, UTF-8 text)."
    return null
  }

  fun initializeStt(
    instanceId: String,
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
    modelingUnit: String?,
    bpeVocab: String?,
    promise: Promise
  ) {
    try {
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        val errorMsg = "Model directory does not exist: $modelDir"
        Log.e(logTag, errorMsg)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
        return
      }

      if (!modelDirFile.isDirectory) {
        val errorMsg = "Model path is not a directory: $modelDir"
        Log.e(logTag, errorMsg)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
        return
      }

      val result = detectSttModel(
        modelDir,
        null,
        modelType ?: "auto",
        preferInt8 ?: false,
        preferInt8 != null,
        debug ?: false
      )

      if (result == null) {
        val errorMsg = "Failed to detect STT model. Check native logs for details."
        Log.e(logTag, "Detection returned null for modelDir: $modelDir")
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
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
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
        return
      }

      val paths = result["paths"] as? Map<*, *> ?: emptyMap<String, String>()
      val pathStrings = paths.mapValues { (_, v) -> (v as? String).orEmpty() }.mapKeys { it.key.toString() }
      val modelTypeStr = result["modelType"] as? String ?: "unknown"

      val hotwordsFileTrimmed = hotwordsFile?.trim().orEmpty()
      if (hotwordsFileTrimmed.isNotEmpty() && !supportsHotwords(modelTypeStr)) {
        val errorMsg = "Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type: $modelTypeStr"
        Log.e(logTag, errorMsg)
        promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg)
        return
      }
      val resolvedHotwordsPath = if (hotwordsFileTrimmed.isNotEmpty()) {
        try {
          resolveHotwordsPath(hotwordsFileTrimmed)
        } catch (e: Exception) {
          val errorMsg = e.message ?: "Hotwords file could not be resolved"
          Log.e(logTag, errorMsg, e)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
          return
        }
      } else ""
      if (resolvedHotwordsPath.isNotEmpty()) {
        validateHotwordsFile(resolvedHotwordsPath)?.let { errorMsg ->
          Log.e(logTag, errorMsg)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg)
          return
        }
      }

      val resolvedRuleFsts = try {
        resolveFilePaths(ruleFsts.orEmpty().trim(), "stt_rule_fst")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FST path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
        return
      }
      val resolvedRuleFars = try {
        resolveFilePaths(ruleFars.orEmpty().trim(), "stt_rule_far")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FAR path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
        return
      }

      val inst = instances.getOrPut(instanceId) { SttEngineInstance() }
      inst.recognizer?.release()
      inst.recognizer = null
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
        modelOptions = modelOptions,
        modelingUnit = modelingUnit?.trim().orEmpty(),
        bpeVocab = bpeVocab?.trim().orEmpty()
      )
      inst.lastRecognizerConfig = config
      inst.currentSttModelType = modelTypeStr
      inst.qwen3HotwordsForStream = if (modelTypeStr == "qwen3_asr") {
        normalizeQwen3HotwordsCsv(modelOptions?.getMap("qwen3Asr")?.getString("hotwords")?.trim().orEmpty())
      } else ""
      // Defer recognizer creation to the dedicated background thread so release() of the previous
      // recognizer can complete off the UI thread (avoids "destroyed mutex" / SIGSEGV when switching models).
      initHandler.post {
        try {
          inst.recognizer = OfflineRecognizer(config = config)
          val resultMap = Arguments.createMap()
          resultMap.putBoolean("success", true)
          resultMap.putString("modelType", modelTypeStr)
          resultMap.putString("decodingMethod", config.decodingMethod)
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
          val errorMsg = "Exception creating recognizer: ${e.message ?: e.javaClass.simpleName}"
          Log.e(logTag, errorMsg, e)
          promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
        }
      }
    } catch (e: Exception) {
      val errorMsg = "Exception during initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMsg, e)
      promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
    }
  }

  fun transcribe(instanceId: String, bufferId: String, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
        return
      }
      val rec = inst.recognizer
      if (rec == null) {
        promise.reject(SttErrorCodes.NOT_INITIALIZED, "STT not initialized. Call initializeStt first.")
        return
      }
      val entry = PipelineAudioRegistry.getOffline(bufferId)
      if (entry == null) {
        if (PipelineAudioRegistry.getLive(bufferId) != null) {
          promise.reject(
            SttErrorCodes.BUFFER_KIND_MISMATCH,
            "Buffer kind mismatch: expected offline buffer, got live buffer: $bufferId"
          )
          return
        }
        promise.reject(SttErrorCodes.BUFFER_NOT_FOUND, "Offline audio buffer not found: $bufferId")
        return
      }
      if (entry.numSamples == 0) {
        promise.reject(SttErrorCodes.BUFFER_EMPTY, "Audio buffer is empty: $bufferId")
        return
      }
      val samples = entry.readAllSamples()
      val stream: OfflineStream = rec.createStream()
      try {
        if (inst.currentSttModelType == "qwen3_asr") {
          val hw = inst.qwen3HotwordsForStream
          if (hw.isNotEmpty()) stream.setOption("hotwords", hw)
        }
        stream.acceptWaveform(samples, entry.sampleRate)
        rec.decode(stream)
        val result = rec.getResult(stream)
        val retained = retainResult(result, entry.sampleRate, "buffer")
        val resultId = inst.resultSlot.store(retained)
        promise.resolve(retained.toTranscribeRefMap(resultId))
      } finally {
        stream.release()
      }
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe from audio buffer"
      Log.e(logTag, "transcribe error: $message", e)
      promise.reject(SttErrorCodes.TRANSCRIBE_FAILED, message, e)
    }
  }

  // ==================== Result Getters ====================

  fun getSttResultText(instanceId: String, resultId: Double, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
      return
    }
    val slot = inst.resultSlot
    if (slot.isEmpty()) {
      promise.reject(SttErrorCodes.RESULT_EMPTY, "No retained result for instance: $instanceId")
      return
    }
    if (slot.isStale(resultId.toLong())) {
      promise.reject(SttErrorCodes.STALE_RESULT, "Result ${resultId.toLong()} is stale; current is ${slot.currentResultId}. Materialize data before the next transcribe or use a second instance.")
      return
    }
    promise.resolve(slot.result!!.text)
  }

  fun getSttResultTokens(instanceId: String, resultId: Double, start: Int, maxCount: Int, promise: Promise) {
    val validated = validateSliceArgs(instanceId, resultId, start, maxCount, promise) ?: return
    val tokens = validated.tokens
    val end = minOf(start + maxCount, tokens.size)
    val arr = Arguments.createArray()
    for (i in start until end) arr.pushString(tokens[i])
    promise.resolve(arr)
  }

  fun getSttResultTimestamps(instanceId: String, resultId: Double, start: Int, maxCount: Int, promise: Promise) {
    val validated = validateSliceArgs(instanceId, resultId, start, maxCount, promise) ?: return
    val timestamps = validated.timestamps
    val end = minOf(start + maxCount, timestamps.size)
    val arr = Arguments.createArray()
    for (i in start until end) arr.pushDouble(timestamps[i].toDouble())
    promise.resolve(arr)
  }

  fun getSttResultDurations(instanceId: String, resultId: Double, start: Int, maxCount: Int, promise: Promise) {
    val validated = validateSliceArgs(instanceId, resultId, start, maxCount, promise) ?: return
    val durations = validated.durations
    val end = minOf(start + maxCount, durations.size)
    val arr = Arguments.createArray()
    for (i in start until end) arr.pushDouble(durations[i].toDouble())
    promise.resolve(arr)
  }

  fun getSttResultLang(instanceId: String, resultId: Double, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
      return
    }
    val slot = inst.resultSlot
    if (slot.isEmpty()) { promise.reject(SttErrorCodes.RESULT_EMPTY, "No retained result"); return }
    if (slot.isStale(resultId.toLong())) { promise.reject(SttErrorCodes.STALE_RESULT, "Result stale"); return }
    promise.resolve(slot.result!!.lang)
  }

  fun getSttResultEmotion(instanceId: String, resultId: Double, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
      return
    }
    val slot = inst.resultSlot
    if (slot.isEmpty()) { promise.reject(SttErrorCodes.RESULT_EMPTY, "No retained result"); return }
    if (slot.isStale(resultId.toLong())) { promise.reject(SttErrorCodes.STALE_RESULT, "Result stale"); return }
    promise.resolve(slot.result!!.emotion)
  }

  fun getSttResultEvent(instanceId: String, resultId: Double, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
      return
    }
    val slot = inst.resultSlot
    if (slot.isEmpty()) { promise.reject(SttErrorCodes.RESULT_EMPTY, "No retained result"); return }
    if (slot.isStale(resultId.toLong())) { promise.reject(SttErrorCodes.STALE_RESULT, "Result stale"); return }
    promise.resolve(slot.result!!.event)
  }

  fun releaseSttResult(instanceId: String, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
      return
    }
    inst.resultSlot.release()
    promise.resolve(null)
  }

  private fun validateSliceArgs(instanceId: String, resultId: Double, start: Int, maxCount: Int, promise: Promise): SttRetainedResult? {
    val inst = getInstance(instanceId) ?: run {
      promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
      return null
    }
    val slot = inst.resultSlot
    if (slot.isEmpty()) {
      promise.reject(SttErrorCodes.RESULT_EMPTY, "No retained result for instance: $instanceId")
      return null
    }
    if (slot.isStale(resultId.toLong())) {
      promise.reject(SttErrorCodes.STALE_RESULT, "Result ${resultId.toLong()} is stale; current is ${slot.currentResultId}")
      return null
    }
    if (start < 0) {
      promise.reject(SttErrorCodes.SLICE_INVALID, "start must be >= 0, got $start")
      return null
    }
    if (maxCount <= 0) {
      promise.reject(SttErrorCodes.SLICE_INVALID, "maxCount must be > 0, got $maxCount")
      return null
    }
    if (maxCount > SttErrorCodes.STT_MAX_SLICE_COUNT) {
      promise.reject(SttErrorCodes.SLICE_TOO_LARGE, "maxCount $maxCount exceeds max ${SttErrorCodes.STT_MAX_SLICE_COUNT}")
      return null
    }
    return slot.result!!
  }

  private fun retainResult(result: OfflineRecognizerResult, sampleRate: Int, source: String): SttRetainedResult {
    return SttRetainedResult(
      text = result.text,
      tokens = result.tokens,
      timestamps = result.timestamps,
      durations = result.durations,
      lang = result.lang,
      emotion = result.emotion,
      event = result.event,
      sampleRate = sampleRate,
      source = source
    )
  }

  fun setSttConfig(instanceId: String, options: ReadableMap, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
        return
      }
      val rec = inst.recognizer
      val current = inst.lastRecognizerConfig
      if (rec == null || current == null) {
        promise.reject(SttErrorCodes.NOT_INITIALIZED, "STT not initialized. Call initializeStt first.")
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
        promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
        return
      }
      val resolvedRuleFars = try {
        resolveFilePaths(merged.ruleFars.trim(), "stt_rule_far")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FAR path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
        return
      }

      val newHotwordsFile = merged.hotwordsFile.trim()
      val resolvedHotwordsPath = if (newHotwordsFile.isNotEmpty()) {
        val modelType = inst.currentSttModelType
        if (modelType == null || !supportsHotwords(modelType)) {
          val errorMsg = "Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type: ${modelType ?: "unknown"}"
          Log.e(logTag, errorMsg)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg)
          return
        }
        try {
          resolveHotwordsPath(newHotwordsFile)
        } catch (e: Exception) {
          val errorMsg = e.message ?: "Hotwords file could not be resolved"
          Log.e(logTag, errorMsg, e)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
          return
        }.also { path ->
          validateHotwordsFile(path)?.let { errorMsg ->
            Log.e(logTag, errorMsg)
            promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg)
            return
          }
        }
      } else ""
      val configWithPaths = merged.copy(
        hotwordsFile = resolvedHotwordsPath,
        ruleFsts = resolvedRuleFsts,
        ruleFars = resolvedRuleFars
      )
      val configToApply = if (configWithPaths.hotwordsFile.isNotEmpty()) {
        configWithPaths.copy(
          decodingMethod = "modified_beam_search",
          maxActivePaths = maxOf(4, configWithPaths.maxActivePaths)
        )
      } else configWithPaths
      inst.lastRecognizerConfig = configToApply
      rec.setConfig(configToApply)
      promise.resolve(null)
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to set STT config"
      Log.e(logTag, "setSttConfig error: $message", e)
      promise.reject(SttErrorCodes.CONFIG_FAILED, message, e)
    }
  }

  fun unloadStt(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId)
      if (inst != null) {
        inst.resultSlot.release()
        inst.recognizer?.release()
        inst.recognizer = null
        inst.lastRecognizerConfig = null
        inst.currentSttModelType = null
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(SttErrorCodes.INTERNAL_ERROR, "Failed to release resources", e)
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
    modelOptions.getMap("qwen3Asr")?.let { q ->
      val mnt = if (q.hasKey("maxNewTokens")) q.getInt("maxNewTokens") else null
      val hasHw = q.hasKey("hotwords") && q.getString("hotwords")?.isNotBlank() == true
      parts.add("qwen3Asr:maxNewTokens=$mnt,hotwords=$hasHw")
    }
    modelOptions.getMap("cohereTranscribe")?.let { c ->
      val lang = c.getString("language") ?: ""
      parts.add("cohereTranscribe:lang=$lang")
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
    modelOptions: ReadableMap? = null,
    modelingUnit: String = "",
    bpeVocab: String = ""
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
          cachedDecoder = path(paths, "moonshineCachedDecoder"),
          mergedDecoder = ""
        ),
        tokens = path(paths, "tokens"),
        modelType = "moonshine"
      )
      "moonshine_v2" -> OfflineModelConfig(
        moonshine = OfflineMoonshineModelConfig(
          encoder = path(paths, "moonshineEncoder"),
          mergedDecoder = path(paths, "moonshineMergedDecoder")
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
      "qwen3_asr" -> {
        val q3 = modelOptions?.getMap("qwen3Asr")
        OfflineModelConfig(
          qwen3Asr = OfflineQwen3AsrModelConfig(
            convFrontend = path(paths, "qwen3ConvFrontend"),
            encoder = path(paths, "qwen3Encoder"),
            decoder = path(paths, "qwen3Decoder"),
            tokenizer = path(paths, "qwen3Tokenizer"),
            maxTotalLen = if (q3?.hasKey("maxTotalLen") == true) q3.getInt("maxTotalLen") else 512,
            maxNewTokens = if (q3?.hasKey("maxNewTokens") == true) q3.getInt("maxNewTokens") else 128,
            temperature = if (q3?.hasKey("temperature") == true) q3.getDouble("temperature").toFloat() else 1e-6f,
            topP = if (q3?.hasKey("topP") == true) q3.getDouble("topP").toFloat() else 0.8f,
            seed = if (q3?.hasKey("seed") == true) q3.getInt("seed") else 42,
            hotwords = ""
          ),
          tokens = ""
        )
      }
      "cohere_transcribe" -> {
        val ct = modelOptions?.getMap("cohereTranscribe")
        OfflineModelConfig(
          cohereTranscribe = OfflineCohereTranscribeModelConfig(
            encoder = path(paths, "cohereEncoder"),
            decoder = path(paths, "cohereDecoder"),
            language = ct?.getString("language")?.trim()?.takeIf { it.isNotEmpty() } ?: "en",
            usePunct = if (ct?.hasKey("usePunct") == true) ct.getBoolean("usePunct") else true,
            useItn = if (ct?.hasKey("useItn") == true) ct.getBoolean("useItn") else true
          ),
          tokens = path(paths, "tokens"),
          modelType = "cohere_transcribe"
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
    val effectiveBpeVocab = bpeVocab.ifEmpty { path(paths, "bpeVocab") }
    val finalModelConfig = modelConfig.copy(
      numThreads = numThreads ?: 1,
      provider = provider ?: "cpu",
      modelingUnit = modelingUnit,
      bpeVocab = effectiveBpeVocab
    )
    val baseConfig = OfflineRecognizerConfig(
      featConfig = featConfig,
      modelConfig = finalModelConfig,
      hotwordsFile = hotwordsFile,
      hotwordsScore = hotwordsScore,
      ruleFsts = ruleFsts,
      ruleFars = ruleFars
    )
    return if (hotwordsFile.isNotEmpty() && (modelType == "transducer" || modelType == "nemo_transducer")) {
      baseConfig.copy(
        decodingMethod = "modified_beam_search",
        maxActivePaths = maxOf(4, baseConfig.maxActivePaths)
      )
    } else baseConfig
  }
}
