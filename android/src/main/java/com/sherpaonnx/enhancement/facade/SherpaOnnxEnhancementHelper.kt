package com.sherpaonnx.enhancement.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiserConfig
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.enhancement.core.EnhancementErrorCodes
import com.sherpaonnx.enhancement.core.EnhancementInstance
import com.sherpaonnx.enhancement.core.EnhancementModelConfigFactory
import com.sherpaonnx.enhancement.core.EnhancementResultMapper
import com.sherpaonnx.enhancement.core.OnlineEnhancementInstance
import com.sherpaonnx.enhancement.pipeline.EnhancementPipelineWorker
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxEnhancementHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectEnhancementModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?,
) {
  private val instances = ConcurrentHashMap<String, EnhancementInstance>()
  private val onlineInstances = ConcurrentHashMap<String, OnlineEnhancementInstance>()

  fun shutdown() {
    instances.values.forEach { it.release() }
    instances.clear()
    onlineInstances.values.forEach { it.release() }
    onlineInstances.clear()
  }

  fun detectEnhancementModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise,
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject(EnhancementErrorCodes.DETECT_ERROR, "Enhancement model detection returned null")
        return
      }
      promise.resolve(EnhancementResultMapper.detectResultToWritable(result))
    } catch (e: Exception) {
      Log.e(EnhancementErrorCodes.TAG, "Enhancement detection failed", e)
      promise.reject(
        EnhancementErrorCodes.DETECT_ERROR,
        "Enhancement model detection failed: ${e.message}",
        e,
      )
    }
  }

  fun initializeEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise,
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, null, modelType ?: "auto")
      if (result == null || result["success"] as? Boolean != true) {
        val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
        promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, reason)
        return
      }

      val modelTypeStr = EnhancementModelConfigFactory.extractModelType(result)
      val paths = EnhancementModelConfigFactory.extractPaths(result)
      val modelConfig = try {
        EnhancementModelConfigFactory.build(modelTypeStr, paths, numThreads, provider, debug)
      } catch (e: IllegalArgumentException) {
        promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, e.message)
        return
      }

      val inst = instances.getOrPut(instanceId) { EnhancementInstance() }
      inst.release()
      val denoiser = OfflineSpeechDenoiser(
        config = OfflineSpeechDenoiserConfig(model = modelConfig),
      )
      inst.denoiser = denoiser

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putArray(
        "detectedModels",
        EnhancementResultMapper.detectedModelsToWritableArray(result["detectedModels"] as? ArrayList<*>),
      )
      out.putString("modelType", modelTypeStr)
      out.putInt("sampleRate", denoiser.sampleRate)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(EnhancementErrorCodes.TAG, "Failed to initialize enhancement", e)
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR,
        "Failed to initialize enhancement: ${e.message}",
        e,
      )
    }
  }

  fun enhanceOfflineAudioBuffers(
    instanceId: String,
    audioInBufferId: String,
    audioOutBufferId: String,
    promise: Promise,
  ) {
    val denoiser = instances[instanceId]?.denoiser
    if (denoiser == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Enhancement instance not found: $instanceId",
      )
      return
    }

    if (!audioInBufferId.startsWith("off_")) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) for audioIn, got: $audioInBufferId",
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioInBufferId)
    if (audioInEntry == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioInBufferId",
      )
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_EMPTY,
        "Input offline audio buffer is empty: $audioInBufferId",
      )
      return
    }

    if (!audioOutBufferId.startsWith("off_")) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) for audioOut, got: $audioOutBufferId",
      )
      return
    }
    val audioOutEntry = PipelineAudioRegistry.getOffline(audioOutBufferId)
    if (audioOutEntry == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioOutBufferId",
      )
      return
    }
    if (audioOutEntry !is OfflineEntry.InMemory) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_OUTPUT_NOT_EMPTY,
        "Output buffer must be an in-memory offline buffer: $audioOutBufferId",
      )
      return
    }
    if (audioOutEntry.numSamples != 0) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_OUTPUT_NOT_EMPTY,
        "Output offline audio buffer must be empty: $audioOutBufferId",
      )
      return
    }

    try {
      val inputSamples = audioInEntry.readAllSamples()
      val audio = denoiser.run(inputSamples, audioInEntry.sampleRate)
      if (!audioOutEntry.tryAdoptSamples(audio.samples)) {
        promise.reject(
          EnhancementErrorCodes.ENHANCEMENT_OUTPUT_NOT_EMPTY,
          "Output buffer was populated concurrently: $audioOutBufferId",
        )
        return
      }
      // Upgrade output to mmap if it exceeds the threshold
      PipelineAudioRegistry.upgradeToMmapIfNeeded(audioOutBufferId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Failed to enhance audio: ${e.message}",
        e,
      )
    }
  }

  fun getSampleRate(instanceId: String, promise: Promise) {
    val denoiser = instances[instanceId]?.denoiser
    if (denoiser == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Enhancement instance not found: $instanceId",
      )
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
    promise: Promise,
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, null, modelType ?: "auto")
      if (result == null || result["success"] as? Boolean != true) {
        val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
        promise.reject(EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR, reason)
        return
      }

      val modelTypeStr = EnhancementModelConfigFactory.extractModelType(result)
      val paths = EnhancementModelConfigFactory.extractPaths(result)
      val modelConfig = try {
        EnhancementModelConfigFactory.build(modelTypeStr, paths, numThreads, provider, debug)
      } catch (e: IllegalArgumentException) {
        promise.reject(EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR, e.message)
        return
      }

      val inst = onlineInstances.getOrPut(instanceId) { OnlineEnhancementInstance() }
      inst.release()
      val denoiser = OnlineSpeechDenoiser(
        config = OnlineSpeechDenoiserConfig(model = modelConfig),
      )
      inst.denoiser = denoiser

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putInt("sampleRate", denoiser.sampleRate)
      out.putInt("frameShiftInSamples", denoiser.frameShiftInSamples)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        "Failed to initialize online enhancement: ${e.message}",
        e,
      )
    }
  }

  fun startEnhancementPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    audioOutLiveBufferId: String,
    promise: Promise,
  ) {
    val denoiser = onlineInstances[instanceId]?.denoiser
    if (denoiser == null) {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_ERROR,
        "Online enhancement instance not found: $instanceId",
      )
      return
    }

    val inputEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
    if (inputEntry == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND,
        "Input live buffer not found: $audioInLiveBufferId",
      )
      return
    }
    val outputEntry = PipelineAudioRegistry.getLive(audioOutLiveBufferId)
    if (outputEntry == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND,
        "Output live buffer not found: $audioOutLiveBufferId",
      )
      return
    }

    if (inputEntry.kind != "livePcmBuffer") {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_KIND_MISMATCH,
        "Input buffer must be a live buffer",
      )
      return
    }
    if (outputEntry.kind != "livePcmBuffer") {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_KIND_MISMATCH,
        "Output buffer must be a live buffer",
      )
      return
    }

    if (inputEntry.state != LiveEntry.State.RECORDING) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_NOT_RECORDING,
        "Input buffer is not in recording state",
      )
      return
    }

    if (inputEntry.sampleRate != denoiser.sampleRate) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_SAMPLE_RATE_MISMATCH,
        "Input buffer sample rate (${inputEntry.sampleRate}) does not match denoiser sample rate (${denoiser.sampleRate})",
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
      promise.reject(
        EnhancementErrorCodes.STREAMING_PIPELINE_ERROR,
        "Failed to start enhancement pipeline: ${e.message}",
        e,
      )
    }
  }

  fun unloadOnline(instanceId: String, promise: Promise) {
    onlineInstances.remove(instanceId)?.release()
    promise.resolve(null)
  }
}