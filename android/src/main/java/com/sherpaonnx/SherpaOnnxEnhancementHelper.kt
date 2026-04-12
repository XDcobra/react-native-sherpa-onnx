package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserDpdfNetModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiserConfig
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.EnhancementPipelineWorker
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxEnhancementHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectEnhancementModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String
  ) -> HashMap<String, Any>?
) {
  private data class EnhancementInstance(
    @Volatile var denoiser: OfflineSpeechDenoiser? = null
  ) {
    fun release() {
      denoiser?.release()
      denoiser = null
    }
  }

  private data class OnlineEnhancementInstance(
    @Volatile var denoiser: OnlineSpeechDenoiser? = null
  ) {
    fun release() {
      denoiser?.release()
      denoiser = null
    }
  }

  private val instances = ConcurrentHashMap<String, EnhancementInstance>()
  private val onlineInstances = ConcurrentHashMap<String, OnlineEnhancementInstance>()

  fun shutdown() {
    instances.values.forEach { it.release() }
    instances.clear()
    onlineInstances.values.forEach { it.release() }
    onlineInstances.clear()
  }

  private fun path(map: Map<String, String>, key: String): String = map[key].orEmpty()

  fun detectEnhancementModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject("DETECT_ERROR", "Enhancement model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String
      val detectionSources = result["detectionSources"] as? ArrayList<*>
      val languages = result["languages"] as? ArrayList<*>
      val quantization = result["quantization"] as? String
      val error = result["error"] as? String

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
      if (!error.isNullOrBlank()) {
        resultMap.putString("error", error)
      }
      if (detectionSources != null && detectionSources.isNotEmpty()) {
        val sourceArray = Arguments.createArray()
        for (source in detectionSources) {
          if (source is String && source.isNotBlank()) {
            sourceArray.pushString(source)
          }
        }
        resultMap.putArray("detectionSources", sourceArray)
      }
      if (languages != null && languages.isNotEmpty()) {
        val languagesArray = Arguments.createArray()
        for (lang in languages) {
          if (lang is String && lang.isNotBlank()) {
            languagesArray.pushString(lang)
          }
        }
        resultMap.putArray("languages", languagesArray)
      }
      if (!quantization.isNullOrBlank()) {
        resultMap.putString("quantization", quantization)
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxEnhancement", "Enhancement detection failed", e)
      promise.reject("DETECT_ERROR", "Enhancement model detection failed: ${e.message}", e)
    }
  }

  fun initializeEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, null, modelType ?: "auto")
      if (result == null || result["success"] as? Boolean != true) {
        val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
        promise.reject("ENHANCEMENT_INIT_ERROR", reason)
        return
      }
      val modelTypeStr = result["modelType"] as? String ?: "gtcrn"
      val paths = (result["paths"] as? Map<*, *>)
        ?.mapValues { (_, v) -> (v as? String).orEmpty() }
        ?.mapKeys { it.key.toString() }
        ?: emptyMap()

      val offlineModelConfig = when (modelTypeStr) {
        "gtcrn" -> OfflineSpeechDenoiserModelConfig(
          gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        "dpdfnet" -> OfflineSpeechDenoiserModelConfig(
          dpdfnet = OfflineSpeechDenoiserDpdfNetModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        else -> {
          promise.reject("ENHANCEMENT_INIT_ERROR", "Unsupported enhancement model type: $modelTypeStr")
          return
        }
      }

      val inst = instances.getOrPut(instanceId) { EnhancementInstance() }
      inst.release()
      val denoiser = OfflineSpeechDenoiser(
        config = OfflineSpeechDenoiserConfig(model = offlineModelConfig)
      )
      inst.denoiser = denoiser

      val modelsArray = Arguments.createArray()
      val detectedModels = result["detectedModels"] as? ArrayList<*>
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putArray("detectedModels", modelsArray)
      out.putString("modelType", modelTypeStr)
      out.putInt("sampleRate", denoiser.sampleRate)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e("SherpaOnnxEnhancement", "Failed to initialize enhancement", e)
      promise.reject("ENHANCEMENT_INIT_ERROR", "Failed to initialize enhancement: ${e.message}", e)
    }
  }

  fun enhanceOfflineAudioBuffers(
    instanceId: String,
    audioInBufferId: String,
    audioOutBufferId: String,
    promise: Promise
  ) {
    val inst = instances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ENHANCEMENT_ERROR", "Enhancement instance not found: $instanceId")
      return
    }

    // Validate input buffer
    if (!audioInBufferId.startsWith("off_")) {
      promise.reject("ENHANCEMENT_BUFFER_KIND_MISMATCH",
        "Expected offline audio buffer (off_*) for audioIn, got: $audioInBufferId")
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioInBufferId)
    if (audioInEntry == null) {
      promise.reject("ENHANCEMENT_BUFFER_NOT_FOUND",
        "Offline audio buffer not found: $audioInBufferId")
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject("ENHANCEMENT_BUFFER_EMPTY",
        "Input offline audio buffer is empty: $audioInBufferId")
      return
    }

    // Validate output buffer
    if (!audioOutBufferId.startsWith("off_")) {
      promise.reject("ENHANCEMENT_BUFFER_KIND_MISMATCH",
        "Expected offline audio buffer (off_*) for audioOut, got: $audioOutBufferId")
      return
    }
    val audioOutEntry = PipelineAudioRegistry.getOffline(audioOutBufferId)
    if (audioOutEntry == null) {
      promise.reject("ENHANCEMENT_BUFFER_NOT_FOUND",
        "Offline audio buffer not found: $audioOutBufferId")
      return
    }
    if (audioOutEntry !is OfflineEntry.InMemory) {
      promise.reject("ENHANCEMENT_OUTPUT_NOT_EMPTY",
        "Output buffer must be an in-memory offline buffer: $audioOutBufferId")
      return
    }
    if (audioOutEntry.numSamples != 0) {
      promise.reject("ENHANCEMENT_OUTPUT_NOT_EMPTY",
        "Output offline audio buffer must be empty: $audioOutBufferId")
      return
    }

    try {
      val inputSamples = audioInEntry.readAllSamples()
      val audio = denoiser.run(inputSamples, audioInEntry.sampleRate)
      if (!audioOutEntry.tryAdoptSamples(audio.samples)) {
        promise.reject("ENHANCEMENT_OUTPUT_NOT_EMPTY",
          "Output buffer was populated concurrently: $audioOutBufferId")
        return
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ENHANCEMENT_ERROR", "Failed to enhance audio: ${e.message}", e)
    }
  }

  fun getSampleRate(instanceId: String, promise: Promise) {
    val inst = instances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ENHANCEMENT_ERROR", "Enhancement instance not found: $instanceId")
      return
    }
    promise.resolve(denoiser.sampleRate)
  }

  fun unloadEnhancement(instanceId: String, promise: Promise) {
    instances.remove(instanceId)?.release()
    promise.resolve(null)
  }

  fun initializeOnlineEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, null, modelType ?: "auto")
      if (result == null || result["success"] as? Boolean != true) {
        val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
        promise.reject("ONLINE_ENHANCEMENT_INIT_ERROR", reason)
        return
      }
      val modelTypeStr = result["modelType"] as? String ?: "gtcrn"
      val paths = (result["paths"] as? Map<*, *>)
        ?.mapValues { (_, v) -> (v as? String).orEmpty() }
        ?.mapKeys { it.key.toString() }
        ?: emptyMap()

      val offlineModelConfig = when (modelTypeStr) {
        "gtcrn" -> OfflineSpeechDenoiserModelConfig(
          gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        "dpdfnet" -> OfflineSpeechDenoiserModelConfig(
          dpdfnet = OfflineSpeechDenoiserDpdfNetModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        else -> {
          promise.reject("ONLINE_ENHANCEMENT_INIT_ERROR", "Unsupported enhancement model type: $modelTypeStr")
          return
        }
      }

      val inst = onlineInstances.getOrPut(instanceId) { OnlineEnhancementInstance() }
      inst.release()
      val denoiser = OnlineSpeechDenoiser(
        config = OnlineSpeechDenoiserConfig(model = offlineModelConfig)
      )
      inst.denoiser = denoiser

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putInt("sampleRate", denoiser.sampleRate)
      out.putInt("frameShiftInSamples", denoiser.frameShiftInSamples)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("ONLINE_ENHANCEMENT_INIT_ERROR", "Failed to initialize online enhancement: ${e.message}", e)
    }
  }

  fun startEnhancementPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    audioOutLiveBufferId: String,
    promise: Promise
  ) {
    val inst = onlineInstances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Online enhancement instance not found: $instanceId")
      return
    }

    val inputEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
    if (inputEntry == null) {
      promise.reject("ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND", "Input live buffer not found: $audioInLiveBufferId")
      return
    }
    val outputEntry = PipelineAudioRegistry.getLive(audioOutLiveBufferId)
    if (outputEntry == null) {
      promise.reject("ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND", "Output live buffer not found: $audioOutLiveBufferId")
      return
    }

    if (inputEntry.kind != "livePcmBuffer") {
      promise.reject("ENHANCEMENT_PIPELINE_BUFFER_KIND_MISMATCH", "Input buffer must be a live buffer")
      return
    }
    if (outputEntry.kind != "livePcmBuffer") {
      promise.reject("ENHANCEMENT_PIPELINE_BUFFER_KIND_MISMATCH", "Output buffer must be a live buffer")
      return
    }

    if (inputEntry.state != com.sherpaonnx.audio.pipeline.LiveEntry.State.RECORDING) {
      promise.reject("ENHANCEMENT_PIPELINE_BUFFER_NOT_RECORDING", "Input buffer is not in recording state")
      return
    }

    if (inputEntry.sampleRate != denoiser.sampleRate) {
      promise.reject(
        "ENHANCEMENT_PIPELINE_SAMPLE_RATE_MISMATCH",
        "Input buffer sample rate (${inputEntry.sampleRate}) does not match denoiser sample rate (${denoiser.sampleRate})"
      )
      return
    }

    try {
      val worker = EnhancementPipelineWorker(denoiser, inputEntry, outputEntry)
      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker)

      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("STREAMING_PIPELINE_ERROR", "Failed to start enhancement pipeline: ${e.message}", e)
    }
  }

  fun unloadOnline(instanceId: String, promise: Promise) {
    onlineInstances.remove(instanceId)?.release()
    promise.resolve(null)
  }
}
