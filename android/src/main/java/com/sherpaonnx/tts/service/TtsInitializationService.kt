package com.sherpaonnx.tts.service

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.k2fsa.sherpa.onnx.OfflineTts
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

  fun initializeTts(
    instanceId: String,
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Double?,
    silenceScale: Double?,
    provider: String?,
    promise: Promise
  ) {
    ttsInitExecutor.execute init@{
      try {
        val result = detectTtsModel(modelDir, null, modelType)
        if (result == null) {
          Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to detect TTS model: native call returned null")
          rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to detect TTS model: native call returned null")
          return@init
        }
        val success = result["success"] as? Boolean ?: false
        if (!success) {
          val reason = result["error"] as? String
          Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: ${reason ?: "Failed to detect TTS model"}")
          rejectOnUiThread(promise, "TTS_INIT_ERROR", reason ?: "Failed to detect TTS model")
          return@init
        }
        val paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
        val modelTypeStr = result["modelType"] as? String ?: "vits"
        val detectedModels = result["detectedModels"] as? ArrayList<*>

        val inst = repository.getOrPut(instanceId) { TtsEngineInstance() }
        inst.stopPcmPlayer()
        inst.releaseEngines()

        val sampleRate: Int
        val numSpeakers: Int

        if (modelTypeStr == "zipvoice") {
          val vocoderPath = TtsOfflineConfigBuilder.path(paths, "vocoder")
          if (vocoderPath.isBlank()) {
            val msg = "Zipvoice distill models (encoder+decoder only, no vocoder) are not supported. Use the full Zipvoice model that includes vocos_24khz.onnx (or similar vocoder file)."
            Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
            rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
            return@init
          }
          val lexiconPath = TtsOfflineConfigBuilder.path(paths, "lexicon")
          if (lexiconPath.isBlank()) {
            val msg = "Zipvoice requires lexicon.txt (or lexicon-<lang>.txt) in the model directory. The sherpa-onnx engine aborts if it is missing. Copy lexicon from the official k2-fsa sherpa-onnx Zipvoice model package or hr-files release next to tokens.txt."
            Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
            rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
            return@init
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
              return@init
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
            paths, "zipvoice", zipvoiceNumThreads, debug,
            noiseScale, noiseScaleW, lengthScale,
            ruleFsts, ruleFars, maxNumSentences?.toInt(), silenceScale,
            provider
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
            return@init
          }
          sampleRate = inst.tts!!.sampleRate()
          numSpeakers = inst.tts!!.numSpeakers()
        } else {
          val config = TtsOfflineConfigBuilder.buildTtsConfig(
            paths, modelTypeStr, numThreads.toInt(), debug,
            noiseScale, noiseScaleW, lengthScale,
            ruleFsts, ruleFars, maxNumSentences?.toInt(), silenceScale,
            provider
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
          numThreads.toInt(),
          debug,
          noiseScale?.takeUnless { it.isNaN() },
          noiseScaleW?.takeUnless { it.isNaN() },
          lengthScale?.takeUnless { it.isNaN() },
          ruleFsts?.takeIf { it.isNotBlank() },
          ruleFars?.takeIf { it.isNotBlank() },
          maxNumSentences?.toInt()?.takeIf { it > 0 },
          silenceScale?.takeUnless { it.isNaN() },
          provider?.takeIf { it.isNotBlank() }
        )

        Log.i("SherpaOnnxTts", "initializeTts: instanceId=$instanceId, engine=kotlin-api modelType=$modelTypeStr, sampleRate=$sampleRate, numSpeakers=$numSpeakers")

        val resultMap = Arguments.createMap()
        resultMap.putBoolean("success", true)
        resultMap.putArray("detectedModels", modelsArray)
        resultMap.putInt("sampleRate", sampleRate)
        resultMap.putInt("numSpeakers", numSpeakers)
        resolveOnUiThread(promise, resultMap)
      } catch (e: Exception) {
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to initialize TTS: ${e.message}", e)
        rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to initialize TTS: ${e.message}", e)
      }
    }
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
