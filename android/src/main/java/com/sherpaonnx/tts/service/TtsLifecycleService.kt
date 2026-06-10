package com.sherpaonnx.tts.service

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.core.dispatchNumSpeakers
import com.sherpaonnx.tts.core.dispatchSampleRate

/**
 * Engine lifecycle, metadata, catalog helpers, and init executor shutdown.
 */
internal class TtsLifecycleService(
  private val repository: TtsEngineRepository,
  private val ttsInitExecutor: java.util.concurrent.ExecutorService,
  private val nativeDetectTtsModel: (String, String?, String?) -> HashMap<String, Any>?,
) {
  /**
   * Shuts down the TTS init executor and releases all engine instances.
   * Call from the native module's onCatalystInstanceDestroy() to avoid leaking the executor thread.
   */
  fun shutdown() {
    try {
      ttsInitExecutor.shutdown()
      if (!ttsInitExecutor.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS)) {
        ttsInitExecutor.shutdownNow()
      }
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      ttsInitExecutor.shutdownNow()
    }
    repository.forEachInstance { inst ->
      inst.releaseEngines()
    }
    repository.clear()
  }

  fun getTtsSampleRate(instanceId: String, promise: Promise) {
    try {
      val inst = repository[instanceId] ?: run {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS not initialized")
        promise.reject("TTS_ERROR", "TTS not initialized")
        return
      }
      promise.resolve(inst.dispatchSampleRate().toDouble())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_ERROR: Failed to get sample rate", e)
      promise.reject("TTS_ERROR", "Failed to get sample rate", e)
    }
  }

  fun getTtsNumSpeakers(instanceId: String, promise: Promise) {
    try {
      val inst = repository[instanceId] ?: run {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS not initialized")
        promise.reject("TTS_ERROR", "TTS not initialized")
        return
      }
      promise.resolve(inst.dispatchNumSpeakers().toDouble())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_ERROR: Failed to get number of speakers", e)
      promise.reject("TTS_ERROR", "Failed to get number of speakers", e)
    }
  }

  fun unloadTts(instanceId: String, promise: Promise) {
    try {
      val inst = repository.remove(instanceId)
      if (inst != null) {
        inst.releaseEngines()
      }
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_RELEASE_ERROR: Failed to release TTS resources", e)
      promise.reject("TTS_RELEASE_ERROR", "Failed to release TTS resources", e)
    }
  }

  /**
   * Detect TTS model type and structure without initializing the engine.
   * Mirrors [SherpaOnnxModule.detectTtsModel] for delegation from facades.
   */
  fun detectTtsModel(modelDir: String, assetName: String?, modelType: String?, promise: Promise) {
    try {
      val result = nativeDetectTtsModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        Log.e("SherpaOnnx", "DETECT_ERROR: TTS model detection returned null")
        promise.reject("DETECT_ERROR", "TTS model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String
      val paths = result["paths"] as? HashMap<*, *>

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", success)
      val modelsArray = Arguments.createArray()
      for (model in detectedModels) {
        val modelMap = model as? HashMap<*, *>
        if (modelMap != null) {
          val entry = Arguments.createMap()
          entry.putString("type", modelMap["type"] as? String ?: "")
          entry.putString("modelDir", modelMap["modelDir"] as? String ?: "")
          modelsArray.pushMap(entry)
        }
      }
      resultMap.putArray("detectedModels", modelsArray)
      if (modelTypeStr != null) {
        resultMap.putString("modelType", modelTypeStr)
      }
      val modelPath = (paths?.get("ttsModel") ?: paths?.get("model")) as? String
      if (!modelPath.isNullOrBlank()) {
        val pathsMap = Arguments.createMap()
        pathsMap.putString("model", modelPath)
        resultMap.putMap("paths", pathsMap)
      }
      if (!success) {
        val error = result["error"] as? String
        if (!error.isNullOrBlank()) {
          resultMap.putString("error", error)
        }
      }
      val lexiconLanguages = result["lexiconLanguages"] as? ArrayList<*>
      if (!lexiconLanguages.isNullOrEmpty()) {
        val lexiconArray = Arguments.createArray()
        for (entry in lexiconLanguages) {
          if (entry is HashMap<*, *>) {
            val map = Arguments.createMap()
            map.putString("id", entry["id"] as? String ?: "")
            map.putString("path", entry["path"] as? String ?: "")
            lexiconArray.pushMap(map)
          }
        }
        resultMap.putArray("lexiconLanguages", lexiconArray)
      }
      val derivedLangs = result["languages"] as? ArrayList<*>
      if (!derivedLangs.isNullOrEmpty()) {
        val langs = Arguments.createArray()
        for (c in derivedLangs) {
          (c as? String)?.let { langs.pushString(it) }
        }
        resultMap.putArray("languages", langs)
      }
      val q = result["quantization"] as? String
      if (!q.isNullOrBlank()) {
        resultMap.putString("quantization", q)
      }
      val st = result["sizeTier"] as? String
      if (!st.isNullOrBlank()) {
        resultMap.putString("sizeTier", st)
      }
      val detectionSources = result["detectionSources"] as? ArrayList<*>
      if (!detectionSources.isNullOrEmpty()) {
        val srcArr = Arguments.createArray()
        for (c in detectionSources) {
          (c as? String)?.let { srcArr.pushString(it) }
        }
        resultMap.putArray("detectionSources", srcArr)
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnx", "DETECT_ERROR: TTS model detection failed: ${e.message}", e)
      promise.reject("DETECT_ERROR", "TTS model detection failed: ${e.message}", e)
    }
  }
}
