package com.sherpaonnx.tts.service

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.tts.config.TtsInitOptionsParser
import com.sherpaonnx.tts.core.TtsEngineInstance
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.core.TtsInitState
import com.sherpaonnx.tts.nativeapi.TtsNative

/**
 * Single-thread executor for TTS init so the RN bridge thread is not blocked.
 */
internal class TtsInitializationService(
  private val context: ReactApplicationContext,
  private val repository: TtsEngineRepository,
  private val detectTtsModel: (modelDir: String, assetName: String?, modelType: String?, quantization: String?) -> HashMap<String, Any>?,
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

  /** Android AAR defaults when options are nil — preserve via JNI args. */
  private fun noiseScaleOrDefault(v: Double?): Float = v?.toFloat() ?: 0.667f
  private fun noiseScaleWOrDefault(v: Double?): Float = v?.toFloat() ?: 0.8f
  private fun lengthScaleOrDefault(v: Double?): Float = v?.toFloat() ?: 1.0f
  private fun silenceScaleOrDefault(v: Double?): Float = v?.toFloat()?.coerceIn(0f, 10f) ?: 0.2f

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
        Log.e("SherpaOnnxTts", "[SherpaOnnx:init] tts Create branch=reject ${e.message}", e)
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
    val result = detectTtsModel(modelDir, null, parsed.modelType, parsed.quantization)
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
    val inst = repository.getOrPut(instanceId) { TtsEngineInstance(instanceId) }
    inst.releaseEngines()

    if (modelTypeStr == "zipvoice") {
      val vocoderPath = paths["vocoder"].orEmpty()
      if (vocoderPath.isBlank()) {
        val msg = "Zipvoice distill models (encoder+decoder only, no vocoder) are not supported. Use the full Zipvoice model that includes vocos_24khz.onnx (or similar vocoder file)."
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
    }

    val numThreads = if (modelTypeStr == "zipvoice") 1 else parsed.numThreads.toInt()
    Log.i("SherpaOnnxTts", "[SherpaOnnx:init] tts Create start modelType=$modelTypeStr")
    @Suppress("UNCHECKED_CAST")
    val raw = TtsNative.nativeInitializeCustom(
      instanceId = instanceId,
      modelType = modelTypeStr,
      paths = HashMap(paths),
      numThreads = numThreads,
      debug = parsed.debug,
      noiseScale = noiseScaleOrDefault(parsed.noiseScale),
      noiseScaleW = noiseScaleWOrDefault(parsed.noiseScaleW),
      lengthScale = lengthScaleOrDefault(parsed.lengthScale),
      ruleFsts = parsed.ruleFsts?.takeIf { it.isNotBlank() },
      ruleFars = parsed.ruleFars?.takeIf { it.isNotBlank() },
      maxNumSentences = parsed.maxNumSentences?.toInt()?.coerceAtLeast(1) ?: 1,
      silenceScale = silenceScaleOrDefault(parsed.silenceScale),
      provider = parsed.provider?.takeIf { it.isNotBlank() } ?: "cpu",
      kokoroLang = parsed.kokoroLang?.takeIf { it.isNotBlank() },
    ) as? HashMap<String, Any>

    val err = TtsNative.initError(raw)
    if (err != null) {
      Log.e("SherpaOnnxTts", "[SherpaOnnx:init] tts Create branch=reject $err")
      rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to create TTS engine: $err")
      return
    }

    inst.ready = true
    val sampleRate = TtsNative.nativeGetSampleRate(instanceId)
    val numSpeakers = TtsNative.nativeGetNumSpeakers(instanceId)
    Log.i("SherpaOnnxTts", "[SherpaOnnx:init] tts Create ok")

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
      numThreads,
      parsed.debug,
      parsed.noiseScale?.takeUnless { it.isNaN() },
      parsed.noiseScaleW?.takeUnless { it.isNaN() },
      parsed.lengthScale?.takeUnless { it.isNaN() },
      parsed.ruleFsts?.takeIf { it.isNotBlank() },
      parsed.ruleFars?.takeIf { it.isNotBlank() },
      parsed.maxNumSentences?.toInt()?.takeIf { it > 0 },
      parsed.silenceScale?.takeUnless { it.isNaN() },
      parsed.provider?.takeIf { it.isNotBlank() },
      parsed.quantization?.takeIf { it.isNotBlank() },
      parsed.kokoroLang?.takeIf { it.isNotBlank() },
    )

    Log.i("SherpaOnnxTts", "initializeTts: instanceId=$instanceId, engine=cxx-api modelType=$modelTypeStr, sampleRate=$sampleRate, numSpeakers=$numSpeakers")

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
      val result = detectTtsModel(state.modelDir, null, state.modelType, state.quantization)
      if (result == null || result["success"] as? Boolean != true) {
        Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Failed to re-detect TTS model")
        promise.reject("TTS_UPDATE_ERROR", "Failed to re-detect TTS model")
        return
      }
      val paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
      val modelTypeStr = result["modelType"] as? String ?: state.modelType
      val detectedModels = result["detectedModels"] as? ArrayList<*>

      inst.releaseEngines()

      @Suppress("UNCHECKED_CAST")
      val raw = TtsNative.nativeInitializeCustom(
        instanceId = instanceId,
        modelType = modelTypeStr,
        paths = HashMap(paths),
        numThreads = state.numThreads,
        debug = state.debug,
        noiseScale = noiseScaleOrDefault(nextNoiseScale),
        noiseScaleW = noiseScaleWOrDefault(nextNoiseScaleW),
        lengthScale = lengthScaleOrDefault(nextLengthScale),
        ruleFsts = state.ruleFsts,
        ruleFars = state.ruleFars,
        maxNumSentences = state.maxNumSentences ?: 1,
        silenceScale = silenceScaleOrDefault(state.silenceScale),
        provider = state.provider ?: "cpu",
        kokoroLang = state.kokoroLang,
      ) as? HashMap<String, Any>

      val err = TtsNative.initError(raw)
      if (err != null) {
        promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params: $err")
        return
      }

      inst.ready = true
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
      resultMap.putInt("sampleRate", TtsNative.nativeGetSampleRate(instanceId))
      resultMap.putInt("numSpeakers", TtsNative.nativeGetNumSpeakers(instanceId))
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Failed to update TTS params", e)
      promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params", e)
    }
  }
}
