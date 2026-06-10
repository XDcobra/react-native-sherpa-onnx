package com.sherpaonnx.tts.service

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.k2fsa.sherpa.onnx.OfflineTts
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.tts.config.TtsInitOptionsParser
import com.sherpaonnx.tts.config.TtsOfflineConfigBuilder
import com.sherpaonnx.tts.core.TtsEngineInstance
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.core.TtsInitState

/**
 * Single-thread executor for TTS init so the RN bridge thread is not blocked (avoids Inspector/dev WebSocket races in debug builds).
 */
internal class TtsInitializationService(
  private val context: ReactApplicationContext,
  private val repository: TtsEngineRepository,
  private val detectTtsModel: (modelDir: String, assetName: String?, modelType: String?) -> HashMap<String, Any>?,
  private val mainHandler: Handler,
  private val ttsInitExecutor: java.util.concurrent.ExecutorService
) {
  private fun resolveOnUiThread(promise: Promise, result: com.facebook.react.bridge.WritableMap) {
    mainHandler.post { promise.resolve(result) }
  }

  private fun rejectOnUiThread(promise: Promise, code: String, message: String, throwable: Throwable? = null) {
    mainHandler.post {
      if (throwable != null) promise.reject(code, message, throwable) else promise.reject(code, message)
    }
  }

  private fun pathsWithLexiconOverride(
    paths: Map<String, String>,
    lexiconLanguages: ArrayList<*>?,
    lexiconLanguageId: String?
  ): Map<String, String> {
    val resolved = TtsInitOptionsParser.resolveLexiconPathFromDetect(lexiconLanguages, lexiconLanguageId)
      ?: return paths
    return paths + ("lexicon" to resolved)
  }

  fun initializeTts(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) {
    val parsed = TtsInitOptionsParser.parse(options)
    if (parsed == null) {
      rejectOnUiThread(
        promise,
        "TTS_INIT_ERROR",
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        }
      )
      return
    }

    ttsInitExecutor.execute init@{
      try {
        if (parsed.initMode == "custom") {
          initializeTtsCustom(instanceId, parsed, promise)
        } else {
          initializeTtsAuto(instanceId, parsed, promise)
        }
      } catch (e: Exception) {
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to initialize TTS: ${e.message}", e)
        rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to initialize TTS: ${e.message}", e)
      }
    }
  }

  private fun initializeTtsAuto(
    instanceId: String,
    parsed: TtsInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    val result = detectTtsModel(modelDir, null, parsed.modelType)
    if (result == null) {
      Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to detect TTS model: native call returned null")
      rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to detect TTS model: native call returned null")
      return
    }
    val success = result["success"] as? Boolean ?: false
    if (!success) {
      val reason = result["error"] as? String
      Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: ${reason ?: "Failed to detect TTS model"}")
      rejectOnUiThread(promise, "TTS_INIT_ERROR", reason ?: "Failed to detect TTS model")
      return
    }
    var paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
    val lexiconLanguages = result["lexiconLanguages"] as? ArrayList<*>
    if (!parsed.lexiconLanguageId.isNullOrBlank()) {
      val resolvedLexicon = TtsInitOptionsParser.resolveLexiconPathFromDetect(lexiconLanguages, parsed.lexiconLanguageId)
      if (resolvedLexicon.isNullOrBlank()) {
        val msg = "lexiconLanguageId '${parsed.lexiconLanguageId}' not found in detected lexiconLanguages"
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
        rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
        return
      }
      paths = paths + ("lexicon" to resolvedLexicon)
    } else {
      paths = pathsWithLexiconOverride(paths, lexiconLanguages, null)
    }
    val modelTypeStr = result["modelType"] as? String ?: "vits"
    val detectedModels = result["detectedModels"] as? ArrayList<*>

    finishInitializeWithPaths(
      instanceId = instanceId,
      modelDir = modelDir,
      paths = paths,
      modelTypeStr = modelTypeStr,
      detectedModels = detectedModels,
      parsed = parsed,
      promise = promise
    )
  }

  private fun initializeTtsCustom(
    instanceId: String,
    parsed: TtsInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      rejectOnUiThread(promise, "TTS_INIT_ERROR", "custom init requires a concrete modelType")
      return
    }
    if (!parsed.lexiconLanguageId.isNullOrBlank()) {
      rejectOnUiThread(
        promise,
        "TTS_INIT_ERROR",
        "lexiconLanguageId is only supported for initMode auto"
      )
      return
    }

    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("tts", modelTypeStr, pathStrings)?.let { errorMsg ->
      Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $errorMsg")
      rejectOnUiThread(promise, "TTS_INIT_ERROR", errorMsg)
      return
    }

    finishInitializeWithPaths(
      instanceId = instanceId,
      modelDir = "custom",
      paths = pathStrings,
      modelTypeStr = modelTypeStr,
      detectedModels = arrayListOf(
        hashMapOf("type" to modelTypeStr, "modelDir" to "custom")
      ),
      parsed = parsed,
      promise = promise
    )
  }

  private fun finishInitializeWithPaths(
    instanceId: String,
    modelDir: String,
    paths: Map<String, String>,
    modelTypeStr: String,
    detectedModels: ArrayList<*>?,
    parsed: TtsInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val inst = repository.getOrPut(instanceId) { TtsEngineInstance() }
    inst.releaseEngines()

    val sampleRate: Int
    val numSpeakers: Int

    if (modelTypeStr == "zipvoice") {
      val vocoderPath = TtsOfflineConfigBuilder.path(paths, "vocoder")
      if (vocoderPath.isBlank()) {
        val msg = "Zipvoice distill models (encoder+decoder only, no vocoder) are not supported. Use the full Zipvoice model that includes vocos_24khz.onnx (or similar vocoder file)."
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
        rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
        return
      }
      val lexiconPath = TtsOfflineConfigBuilder.path(paths, "lexicon")
      if (lexiconPath.isBlank()) {
        val msg = "Zipvoice requires lexicon.txt (or lexicon-<lang>.txt) in the model directory. The sherpa-onnx engine aborts if it is missing. Copy lexicon from the official k2-fsa sherpa-onnx Zipvoice model package or hr-files release next to tokens.txt."
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
        rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
        return
      }
      val am = context.applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      if (am != null) {
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        val availMb = memInfo.availMem / (1024 * 1024)
        if (memInfo.availMem < 800L * 1024 * 1024) {
          val msg = "Not enough free memory to load the Zipvoice model (available: ${availMb} MB). Close other apps to free memory or use a smaller Zipvoice model that includes all required components (encoder, decoder, and vocoder)."
          Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
          rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
          return
        }
      }
      System.gc()
      if (am != null) {
        val memInfoBefore = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfoBefore)
        Log.i("SherpaOnnxTts", "Zipvoice init: availMem=${memInfoBefore.availMem / (1024 * 1024)} MB (before load)")
      }
      val zipvoiceNumThreads = 1
      val config = TtsOfflineConfigBuilder.buildTtsConfig(
        paths, "zipvoice", zipvoiceNumThreads, parsed.debug,
        parsed.noiseScale, parsed.noiseScaleW, parsed.lengthScale,
        parsed.ruleFsts, parsed.ruleFars, parsed.maxNumSentences?.toInt(), parsed.silenceScale,
        parsed.provider,
        parsed.kokoroLang
      )
      if (am != null) {
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        Log.i("SherpaOnnxTts", "Zipvoice init: availMem=${memInfo.availMem / (1024 * 1024)} MB (after load)")
      }
      try {
        inst.tts = OfflineTts(config = config)
      } catch (e: Exception) {
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to create Zipvoice OfflineTts: ${e.message}", e)
        rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to create Zipvoice TTS engine: ${e.message}", e)
        return
      }
      sampleRate = inst.tts!!.sampleRate()
      numSpeakers = inst.tts!!.numSpeakers()
    } else {
      val config = TtsOfflineConfigBuilder.buildTtsConfig(
        paths, modelTypeStr, parsed.numThreads.toInt(), parsed.debug,
        parsed.noiseScale, parsed.noiseScaleW, parsed.lengthScale,
        parsed.ruleFsts, parsed.ruleFars, parsed.maxNumSentences?.toInt(), parsed.silenceScale,
        parsed.provider,
        parsed.kokoroLang
      )
      inst.tts = OfflineTts(config = config)
      sampleRate = inst.tts!!.sampleRate()
      numSpeakers = inst.tts!!.numSpeakers()
    }

    val modelsArray = Arguments.createArray()
    detectedModels?.forEach { modelObj ->
      if (modelObj is HashMap<*, *>) {
        val modelMap = Arguments.createMap()
        modelMap.putString("type", modelObj["type"] as? String ?: "")
        modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
        modelsArray.pushMap(modelMap)
      }
    }

    inst.ttsInitState = TtsInitState(
      modelDir,
      modelTypeStr,
      if (modelTypeStr == "zipvoice") 1 else parsed.numThreads.toInt(),
      parsed.debug,
      parsed.noiseScale?.takeUnless { it.isNaN() },
      parsed.noiseScaleW?.takeUnless { it.isNaN() },
      parsed.lengthScale?.takeUnless { it.isNaN() },
      parsed.ruleFsts?.takeIf { it.isNotBlank() },
      parsed.ruleFars?.takeIf { it.isNotBlank() },
      parsed.maxNumSentences?.toInt()?.takeIf { it > 0 },
      parsed.silenceScale?.takeUnless { it.isNaN() },
      parsed.provider?.takeIf { it.isNotBlank() }
    )

    Log.i("SherpaOnnxTts", "initializeTts: instanceId=$instanceId, engine=kotlin-api modelType=$modelTypeStr, sampleRate=$sampleRate, numSpeakers=$numSpeakers")

    val resultMap = Arguments.createMap()
    resultMap.putBoolean("success", true)
    resultMap.putArray("detectedModels", modelsArray)
    resultMap.putInt("sampleRate", sampleRate)
    resultMap.putInt("numSpeakers", numSpeakers)
    resolveOnUiThread(promise, resultMap)
  }

  fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    val inst = repository[instanceId] ?: run {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_UPDATE_ERROR", "TTS instance not found: $instanceId")
      return
    }
    if (inst.ttsStreamRunning.get()) {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Cannot update params while streaming")
      promise.reject("TTS_UPDATE_ERROR", "Cannot update params while streaming")
      return
    }
    val state = inst.ttsInitState ?: run {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: TTS not initialized")
      promise.reject("TTS_UPDATE_ERROR", "TTS not initialized")
      return
    }

    val nextNoiseScale = when {
      noiseScale == null -> null
      noiseScale.isNaN() -> state.noiseScale
      else -> noiseScale
    }
    val nextNoiseScaleW = when {
      noiseScaleW == null -> null
      noiseScaleW.isNaN() -> state.noiseScaleW
      else -> noiseScaleW
    }
    val nextLengthScale = when {
      lengthScale == null -> null
      lengthScale.isNaN() -> state.lengthScale
      else -> lengthScale
    }
    try {
      val result = detectTtsModel(state.modelDir, null, state.modelType)
      if (result == null || result["success"] as? Boolean != true) {
        Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Failed to re-detect TTS model")
        promise.reject("TTS_UPDATE_ERROR", "Failed to re-detect TTS model")
        return
      }
      val paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
      val modelTypeStr = result["modelType"] as? String ?: state.modelType
      val detectedModels = result["detectedModels"] as? ArrayList<*>

      inst.tts?.release()
      inst.tts = null
      val config = TtsOfflineConfigBuilder.buildTtsConfig(
        paths, modelTypeStr, state.numThreads, state.debug,
        nextNoiseScale, nextNoiseScaleW, nextLengthScale,
        state.ruleFsts, state.ruleFars, state.maxNumSentences, state.silenceScale,
        state.provider
      )
      inst.tts = OfflineTts(config = config)
      val ttsInstance = inst.tts!!

      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      inst.ttsInitState = state.copy(
        noiseScale = nextNoiseScale,
        noiseScaleW = nextNoiseScaleW,
        lengthScale = nextLengthScale
      )

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putArray("detectedModels", modelsArray)
      resultMap.putInt("sampleRate", ttsInstance.sampleRate())
      resultMap.putInt("numSpeakers", ttsInstance.numSpeakers())
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Failed to update TTS params", e)
      promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params", e)
    }
  }
}
