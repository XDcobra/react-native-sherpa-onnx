package com.sherpaonnx.stt.facade

import android.content.Context
import android.os.HandlerThread
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.stt.config.SttInitOptionsParser
import com.sherpaonnx.stt.core.OfflineSttRecognizerConfigFactory
import com.sherpaonnx.stt.core.SttErrorCodes
import com.sherpaonnx.stt.core.SttPathResolver
import com.sherpaonnx.stt.core.normalizeQwen3HotwordsCsv
import com.sherpaonnx.stt.core.supportsHotwords
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
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
    @Volatile var qwen3HotwordsForStream: String = ""
  )

  private val instances = ConcurrentHashMap<String, SttEngineInstance>()

  private val initThread = HandlerThread("stt-init").also { it.start() }
  private val initHandler = android.os.Handler(initThread.looper)

  private fun getInstance(instanceId: String): SttEngineInstance? = instances[instanceId]

  fun getRecognizer(instanceId: String): OfflineRecognizer? =
    getInstance(instanceId)?.recognizer

  private val pathResolver = SttPathResolver(context)
  private val configFactory = OfflineSttRecognizerConfigFactory()

  fun initializeStt(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) {
    val parsed = SttInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(SttErrorCodes.INIT_FAILED, "modelDir is required")
      return
    }
    initializeSttInternal(
      instanceId,
      parsed.modelDir,
      parsed.preferInt8,
      parsed.modelType,
      parsed.debug,
      parsed.hotwordsFile,
      parsed.hotwordsScore,
      parsed.numThreads,
      parsed.provider,
      parsed.ruleFsts,
      parsed.ruleFars,
      parsed.dither,
      parsed.modelOptions,
      parsed.modelingUnit,
      parsed.bpeVocab,
      promise
    )
  }

  private fun initializeSttInternal(
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
          pathResolver.resolveHotwordsPath(hotwordsFileTrimmed)
        } catch (e: Exception) {
          val errorMsg = e.message ?: "Hotwords file could not be resolved"
          Log.e(logTag, errorMsg, e)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
          return
        }
      } else ""
      if (resolvedHotwordsPath.isNotEmpty()) {
        pathResolver.validateHotwordsFile(resolvedHotwordsPath)?.let { errorMsg ->
          Log.e(logTag, errorMsg)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg)
          return
        }
      }

      val resolvedRuleFsts = try {
        pathResolver.resolveFilePaths(ruleFsts.orEmpty().trim(), "stt_rule_fst")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FST path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
        return
      }
      val resolvedRuleFars = try {
        pathResolver.resolveFilePaths(ruleFars.orEmpty().trim(), "stt_rule_far")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FAR path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
        return
      }

      val inst = instances.getOrPut(instanceId) { SttEngineInstance() }
      inst.recognizer?.release()
      inst.recognizer = null
      val config = configFactory.buildRecognizerConfig(
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

  fun transcribe(instanceId: String, bufferId: String, textOutBufferId: String, promise: Promise) {
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
      val textEntry = TextPipelineRegistry.getOffline(textOutBufferId)
      if (textEntry == null) {
        promise.reject(SttErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $textOutBufferId")
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
        textEntry.populate(
          text = result.text,
          tokens = result.tokens,
          timestamps = result.timestamps,
          durations = result.durations,
          lang = result.lang,
          emotion = result.emotion,
          event = result.event
        )
        promise.resolve(null)
      } finally {
        stream.release()
      }
    } catch (e: OutOfMemoryError) {
      Log.e(logTag, "transcribe OOM", e)
      promise.reject(
        SttErrorCodes.OFFLINE_OOM,
        OfflineOomError.message("speech-to-text"),
        e
      )
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe from audio buffer"
      Log.e(logTag, "transcribe error: $message", e)
      promise.reject(SttErrorCodes.TRANSCRIBE_FAILED, message, e)
    }
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
        pathResolver.resolveFilePaths(merged.ruleFsts.trim(), "stt_rule_fst")
      } catch (e: Exception) {
        val errorMsg = e.message ?: "Rule FST path(s) could not be resolved"
        Log.e(logTag, errorMsg, e)
        promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
        return
      }
      val resolvedRuleFars = try {
        pathResolver.resolveFilePaths(merged.ruleFars.trim(), "stt_rule_far")
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
          pathResolver.resolveHotwordsPath(newHotwordsFile)
        } catch (e: Exception) {
          val errorMsg = e.message ?: "Hotwords file could not be resolved"
          Log.e(logTag, errorMsg, e)
          promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg, e)
          return
        }.also { path ->
          pathResolver.validateHotwordsFile(path)?.let { errorMsg ->
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
}
