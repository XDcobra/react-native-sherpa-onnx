package com.sherpaonnx.stt.facade

import android.content.Context
import android.os.HandlerThread
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.stt.config.SttInitOptionsParser
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
    quantization: String?,
    debug: Boolean
  ) -> HashMap<String, Any>?,
  private val logTag: String
) {

  private data class SttEngineInstance(
    @Volatile var ready: Boolean = false,
    @Volatile var currentSttModelType: String? = null,
  )

  private val instances = ConcurrentHashMap<String, SttEngineInstance>()

  private val initThread = HandlerThread("stt-init").also { it.start() }
  private val initHandler = android.os.Handler(initThread.looper)

  private fun getInstance(instanceId: String): SttEngineInstance? = instances[instanceId]

  fun hasNativeInstance(instanceId: String): Boolean =
    getInstance(instanceId)?.ready == true && nativeHasInstance(instanceId)

  private val pathResolver = SttPathResolver(context)

  fun initializeStt(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) {
    val parsed = SttInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        SttErrorCodes.INIT_FAILED,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        }
      )
      return
    }

    if (parsed.initMode == "custom") {
      initializeSttCustom(instanceId, parsed, promise)
      return
    }

    initializeSttAuto(instanceId, parsed, promise)
  }

  private fun initializeSttAuto(
    instanceId: String,
    parsed: SttInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    try {
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        promise.reject(SttErrorCodes.INIT_FAILED, "Model directory does not exist: $modelDir")
        return
      }
      if (!modelDirFile.isDirectory) {
        promise.reject(SttErrorCodes.INIT_FAILED, "Model path is not a directory: $modelDir")
        return
      }

      val result = detectSttModel(
        modelDir,
        null,
        parsed.modelType ?: "auto",
        parsed.quantization,
        parsed.debug ?: false
      )

      if (result == null) {
        promise.reject(SttErrorCodes.INIT_FAILED, "Failed to detect STT model. Check native logs for details.")
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
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
        return
      }

      val paths = result["paths"] as? Map<*, *> ?: emptyMap<String, String>()
      val pathStrings = paths.mapValues { (_, v) -> (v as? String).orEmpty() }.mapKeys { it.key.toString() }
      val modelTypeStr = result["modelType"] as? String ?: "unknown"

      finishInitializeWithPaths(
        instanceId = instanceId,
        pathStrings = pathStrings,
        modelTypeStr = modelTypeStr,
        detectedModels = detectedModels,
        parsed = parsed,
        promise = promise
      )
    } catch (e: Exception) {
      val errorMsg = "Exception during initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMsg, e)
      promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
    }
  }

  private fun initializeSttCustom(
    instanceId: String,
    parsed: SttInitOptionsParser.Parsed,
    promise: Promise
  ) {
    try {
      val modelTypeStr = parsed.modelType?.trim().orEmpty()
      if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
        promise.reject(SttErrorCodes.INIT_FAILED, "custom init requires a concrete modelType")
        return
      }

      val pathStrings = parsed.modelPaths.orEmpty()
      ModelPathValidationNative.validate("stt", modelTypeStr, pathStrings)?.let { errorMsg ->
        Log.e(logTag, errorMsg)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
        return
      }

      finishInitializeWithPaths(
        instanceId = instanceId,
        pathStrings = pathStrings,
        modelTypeStr = modelTypeStr,
        detectedModels = arrayListOf(
          hashMapOf("type" to modelTypeStr, "modelDir" to "custom")
        ),
        parsed = parsed,
        promise = promise
      )
    } catch (e: Exception) {
      val errorMsg = "Exception during custom initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMsg, e)
      promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
    }
  }

  private fun finishInitializeWithPaths(
    instanceId: String,
    pathStrings: Map<String, String>,
    modelTypeStr: String,
    detectedModels: ArrayList<*>,
    parsed: SttInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val hotwordsFileTrimmed = parsed.hotwordsFile?.trim().orEmpty()
    if (hotwordsFileTrimmed.isNotEmpty() && !supportsHotwords(modelTypeStr)) {
      val errorMsg =
        "Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type: $modelTypeStr"
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
      pathResolver.resolveFilePaths(parsed.ruleFsts.orEmpty().trim(), "stt_rule_fst")
    } catch (e: Exception) {
      promise.reject(SttErrorCodes.INIT_FAILED, e.message ?: "Rule FST path(s) could not be resolved", e)
      return
    }
    val resolvedRuleFars = try {
      pathResolver.resolveFilePaths(parsed.ruleFars.orEmpty().trim(), "stt_rule_far")
    } catch (e: Exception) {
      promise.reject(SttErrorCodes.INIT_FAILED, e.message ?: "Rule FAR path(s) could not be resolved", e)
      return
    }

    val paths = HashMap(pathStrings)
    val bpe = parsed.bpeVocab?.trim().orEmpty()
    if (bpe.isNotEmpty() && paths["bpeVocab"].isNullOrEmpty()) {
      paths["bpeVocab"] = bpe
    }

    val whisper = stringOptionsMap(parsed.modelOptions?.getMap("whisper"))
    val senseVoice = stringOptionsMap(parsed.modelOptions?.getMap("senseVoice"))
    val canary = stringOptionsMap(parsed.modelOptions?.getMap("canary"))
    val funasr = stringOptionsMap(parsed.modelOptions?.getMap("funasrNano"))
    val qwen3 = stringOptionsMap(parsed.modelOptions?.getMap("qwen3Asr"))
    val cohere = stringOptionsMap(parsed.modelOptions?.getMap("cohereTranscribe"))
    if (modelTypeStr == "qwen3_asr" && qwen3 != null) {
      val hw = normalizeQwen3HotwordsCsv(qwen3["hotwords"].orEmpty())
      if (hw.isNotEmpty()) qwen3["hotwords"] = hw
    }

    val inst = instances.getOrPut(instanceId) { SttEngineInstance() }
    inst.ready = false
    inst.currentSttModelType = modelTypeStr

    initHandler.post {
      try {
        Log.i(logTag, "[SherpaOnnx:init] stt Create start")
        @Suppress("UNCHECKED_CAST")
        val raw = nativeInitializeCustom(
          instanceId,
          modelTypeStr,
          paths,
          parsed.debug ?: false,
          resolvedHotwordsPath.ifEmpty { null },
          parsed.hotwordsScore?.toFloat() ?: -1f,
          parsed.numThreads?.toInt() ?: 0,
          parsed.provider,
          resolvedRuleFsts.ifEmpty { null },
          resolvedRuleFars.ifEmpty { null },
          parsed.dither?.toFloat() ?: -1f,
          whisper,
          senseVoice,
          canary,
          funasr,
          qwen3,
          cohere,
        ) as? HashMap<String, Any>
        val ok = raw?.get("success") as? Boolean ?: false
        if (!ok) {
          val err = raw?.get("error") as? String ?: "Exception creating recognizer"
          Log.e(logTag, "[SherpaOnnx:init] stt Create branch=reject $err")
          promise.reject(SttErrorCodes.INIT_FAILED, err)
          return@post
        }
        inst.ready = true
        Log.i(logTag, "[SherpaOnnx:init] stt Create ok")
        val resultMap = Arguments.createMap()
        resultMap.putBoolean("success", true)
        resultMap.putString("modelType", raw?.get("modelType") as? String ?: modelTypeStr)
        resultMap.putString("decodingMethod", raw?.get("decodingMethod") as? String ?: "")
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
        Log.e(logTag, "[SherpaOnnx:init] stt Create branch=reject $errorMsg", e)
        promise.reject(SttErrorCodes.INIT_FAILED, errorMsg, e)
      }
    }
  }

  fun transcribe(instanceId: String, bufferId: String, textOutBufferId: String, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
        return
      }
      if (!inst.ready || !nativeHasInstance(instanceId)) {
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
      val gateKey = "stt:$instanceId"
      if (!NativeInstanceGate.beginUse(gateKey)) {
        promise.reject(SttErrorCodes.NOT_INITIALIZED, "STT instance released: $instanceId")
        return
      }
      try {
        val result = transcribeSamplesInternal(instanceId, samples, entry.sampleRate)
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
        NativeInstanceGate.endUse(gateKey)
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

  /** Used by offline-live pipeline worker. */
  fun transcribeSamplesInternal(
    instanceId: String,
    samples: FloatArray,
    sampleRate: Int,
  ): TranscribeResult {
    @Suppress("UNCHECKED_CAST")
    val raw = nativeTranscribeSamples(instanceId, samples, sampleRate) as? HashMap<String, Any>
      ?: throw IllegalStateException("nativeTranscribeSamples returned null")
    val ok = raw["success"] as? Boolean ?: false
    if (!ok) {
      throw IllegalStateException(raw["error"] as? String ?: "Recognition failed")
    }
    @Suppress("UNCHECKED_CAST")
    val tokenList = raw["tokens"] as? ArrayList<*>
    val tokens = tokenList?.map { it?.toString().orEmpty() }?.toTypedArray() ?: emptyArray()
    val timestamps = raw["timestamps"] as? FloatArray ?: floatArrayOf()
    val durations = raw["durations"] as? FloatArray ?: floatArrayOf()
    return TranscribeResult(
      text = raw["text"] as? String ?: "",
      tokens = tokens,
      timestamps = timestamps,
      durations = durations,
      lang = raw["lang"] as? String ?: "",
      emotion = raw["emotion"] as? String ?: "",
      event = raw["event"] as? String ?: "",
    )
  }

  data class TranscribeResult(
    val text: String,
    val tokens: Array<String>,
    val timestamps: FloatArray,
    val durations: FloatArray,
    val lang: String,
    val emotion: String,
    val event: String,
  )

  fun setSttConfig(instanceId: String, options: ReadableMap, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        promise.reject(SttErrorCodes.INSTANCE_NOT_FOUND, "STT instance not found: $instanceId")
        return
      }
      if (!inst.ready || !nativeHasInstance(instanceId)) {
        promise.reject(SttErrorCodes.NOT_INITIALIZED, "STT not initialized. Call initializeStt first.")
        return
      }

      val decodingMethod =
        if (options.hasKey("decodingMethod")) options.getString("decodingMethod") else null
      val maxActivePaths =
        if (options.hasKey("maxActivePaths")) options.getDouble("maxActivePaths").toInt() else 0
      val blankPenalty =
        if (options.hasKey("blankPenalty")) options.getDouble("blankPenalty").toFloat() else -1f
      val hotwordsScore =
        if (options.hasKey("hotwordsScore")) options.getDouble("hotwordsScore").toFloat() else -1f

      var resolvedHotwordsPath: String? = null
      if (options.hasKey("hotwordsFile")) {
        val newHotwordsFile = options.getString("hotwordsFile")?.trim().orEmpty()
        if (newHotwordsFile.isNotEmpty()) {
          val modelType = inst.currentSttModelType
          if (modelType == null || !supportsHotwords(modelType)) {
            promise.reject(
              SttErrorCodes.CONFIG_FAILED,
              "Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type: ${modelType ?: "unknown"}",
            )
            return
          }
          resolvedHotwordsPath = try {
            pathResolver.resolveHotwordsPath(newHotwordsFile)
          } catch (e: Exception) {
            promise.reject(SttErrorCodes.CONFIG_FAILED, e.message ?: "Hotwords file could not be resolved", e)
            return
          }.also { path ->
            pathResolver.validateHotwordsFile(path)?.let { errorMsg ->
              promise.reject(SttErrorCodes.CONFIG_FAILED, errorMsg)
              return
            }
          }
        } else {
          resolvedHotwordsPath = ""
        }
      }

      val resolvedRuleFsts = if (options.hasKey("ruleFsts")) {
        try {
          pathResolver.resolveFilePaths(options.getString("ruleFsts")?.trim().orEmpty(), "stt_rule_fst")
        } catch (e: Exception) {
          promise.reject(SttErrorCodes.CONFIG_FAILED, e.message ?: "Rule FST path(s) could not be resolved", e)
          return
        }
      } else null
      val resolvedRuleFars = if (options.hasKey("ruleFars")) {
        try {
          pathResolver.resolveFilePaths(options.getString("ruleFars")?.trim().orEmpty(), "stt_rule_far")
        } catch (e: Exception) {
          promise.reject(SttErrorCodes.CONFIG_FAILED, e.message ?: "Rule FAR path(s) could not be resolved", e)
          return
        }
      } else null

      @Suppress("UNCHECKED_CAST")
      val raw = nativeSetConfig(
        instanceId,
        decodingMethod,
        maxActivePaths,
        resolvedHotwordsPath,
        hotwordsScore,
        blankPenalty,
        resolvedRuleFsts,
        resolvedRuleFars,
      ) as? HashMap<String, Any>
      val ok = raw?.get("success") as? Boolean ?: false
      if (!ok) {
        promise.reject(SttErrorCodes.CONFIG_FAILED, raw?.get("error") as? String ?: "Failed to set STT config")
        return
      }
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
        val gateKey = "stt:$instanceId"
        NativeInstanceGate.releaseWhenIdle(gateKey) {
          try {
            nativeUnload(instanceId)
          } catch (e: Exception) {
            Log.w(logTag, "Error releasing SttWrapper: ${e.message}")
          }
        }
        inst.ready = false
        inst.currentSttModelType = null
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(SttErrorCodes.INTERNAL_ERROR, "Failed to release resources", e)
    }
  }

  companion object {
    private fun stringOptionsMap(map: ReadableMap?): HashMap<String, String>? {
      if (map == null) return null
      val out = HashMap<String, String>()
      val it = map.keySetIterator()
      while (it.hasNextKey()) {
        val key = it.nextKey()
        when {
          map.isNull(key) -> Unit
          map.getType(key) == com.facebook.react.bridge.ReadableType.String ->
            out[key] = map.getString(key).orEmpty()
          map.getType(key) == com.facebook.react.bridge.ReadableType.Boolean ->
            out[key] = if (map.getBoolean(key)) "true" else "false"
          map.getType(key) == com.facebook.react.bridge.ReadableType.Number ->
            out[key] = map.getDouble(key).toString()
        }
      }
      return if (out.isEmpty()) null else out
    }

    @JvmStatic
    private external fun nativeInitializeCustom(
      instanceId: String,
      modelType: String,
      paths: HashMap<String, String>,
      debug: Boolean,
      hotwordsFile: String?,
      hotwordsScore: Float,
      numThreads: Int,
      provider: String?,
      ruleFsts: String?,
      ruleFars: String?,
      dither: Float,
      whisper: HashMap<String, String>?,
      senseVoice: HashMap<String, String>?,
      canary: HashMap<String, String>?,
      funasr: HashMap<String, String>?,
      qwen3: HashMap<String, String>?,
      cohere: HashMap<String, String>?,
    ): HashMap<String, Any>?

    @JvmStatic
    internal external fun nativeTranscribeSamples(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeSetConfig(
      instanceId: String,
      decodingMethod: String?,
      maxActivePaths: Int,
      hotwordsFile: String?,
      hotwordsScore: Float,
      blankPenalty: Float,
      ruleFsts: String?,
      ruleFars: String?,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeHasInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnload(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }
}
