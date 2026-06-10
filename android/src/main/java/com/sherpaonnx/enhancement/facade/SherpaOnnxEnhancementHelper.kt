package com.sherpaonnx.enhancement.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiserConfig
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.enhancement.config.EnhancementInitOptionsParser
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.enhancement.core.EnhancementErrorCodes
import com.sherpaonnx.enhancement.core.EnhancementInstance
import com.sherpaonnx.enhancement.core.EnhancementModelConfigFactory
import com.sherpaonnx.enhancement.core.EnhancementResultMapper
import com.sherpaonnx.enhancement.core.OnlineEnhancementInstance
import com.sherpaonnx.enhancement.pipeline.EnhancementPipelineWorker
import com.sherpaonnx.enhancement.pipeline.EnhancementOfflineLivePipelineWorker
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.facebook.react.bridge.WritableNativeMap
import java.util.concurrent.ConcurrentHashMap
import java.util.UUID

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
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, "instanceId is required")
      return
    }
    val parsed = EnhancementInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        }
      )
      return
    }
    try {
      if (parsed.initMode == "custom") {
        initializeEnhancementCustom(instanceId, parsed, promise)
      } else {
        initializeEnhancementAuto(instanceId, parsed, promise)
      }
    } catch (e: Exception) {
      Log.e(EnhancementErrorCodes.TAG, "Failed to initialize enhancement", e)
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR,
        "Failed to initialize enhancement: ${e.message}",
        e,
      )
    }
  }

  private fun initializeEnhancementCustom(
    instanceId: String,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR,
        "custom init requires a concrete modelType",
      )
      return
    }
    if (modelTypeStr != "gtcrn" && modelTypeStr != "dpdfnet") {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR,
        "Unsupported enhancement model type: $modelTypeStr",
      )
      return
    }

    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("enhancement", modelTypeStr, pathStrings)?.let { errorMsg ->
      promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, errorMsg)
      return
    }

    finishInitializeOfflineWithModelPath(
      instanceId = instanceId,
      modelTypeStr = modelTypeStr,
      paths = pathStrings,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun initializeEnhancementAuto(
    instanceId: String,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    val result = nativeDetectEnhancementModel(modelDir, null, parsed.modelType)
    if (result == null || result["success"] as? Boolean != true) {
      val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
      promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, reason)
      return
    }

    val modelTypeStr = EnhancementModelConfigFactory.extractModelType(result)
    val paths = EnhancementModelConfigFactory.extractPaths(result)
    finishInitializeOfflineWithModelPath(
      instanceId = instanceId,
      modelTypeStr = modelTypeStr,
      paths = paths,
      parsed = parsed,
      promise = promise,
      detectedModels = result["detectedModels"] as? ArrayList<*>,
    )
  }

  private fun finishInitializeOfflineWithModelPath(
    instanceId: String,
    modelTypeStr: String,
    paths: Map<String, String>,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
    detectedModels: ArrayList<*>? = null,
  ) {
    val modelConfig = try {
      EnhancementModelConfigFactory.build(
        modelTypeStr,
        paths,
        parsed.numThreads,
        parsed.provider,
        parsed.debug,
      )
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
      EnhancementResultMapper.detectedModelsToWritableArray(
        detectedModels ?: arrayListOf(
          hashMapOf(
            "type" to modelTypeStr,
            "modelDir" to (parsed.modelDir ?: "custom"),
          )
        )
      ),
    )
    out.putString("modelType", modelTypeStr)
    out.putInt("sampleRate", denoiser.sampleRate)
    promise.resolve(out)
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
      PipelineAudioRegistry.upgradeToMmapIfNeeded(audioOutBufferId)
      promise.resolve(null)
    } catch (e: OutOfMemoryError) {
      Log.e(EnhancementErrorCodes.TAG, "OOM Enhancement offline failed", e)
      promise.reject(
        EnhancementErrorCodes.OFFLINE_OOM,
        OfflineOomError.message("enhancement"),
        e
      )
    } catch (e: Exception) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Failed to enhance audio: ${e.message}",
        e,
      )
    }
  }

  fun getSampleRate(instanceId: String, promise: Promise) {
    val offlineDenoiser = instances[instanceId]?.denoiser
    val onlineDenoiser = onlineInstances[instanceId]?.denoiser
    val sampleRate = offlineDenoiser?.sampleRate ?: onlineDenoiser?.sampleRate
    if (sampleRate == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Enhancement instance not found: $instanceId",
      )
      return
    }
    promise.resolve(sampleRate)
  }

  fun unloadEnhancement(instanceId: String, promise: Promise) {
    instances.remove(instanceId)?.release()
    promise.resolve(null)
  }

  fun initializeOnlineEnhancement(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR, "instanceId is required")
      return
    }
    val parsed = EnhancementInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        }
      )
      return
    }
    try {
      if (parsed.initMode == "custom") {
        initializeOnlineEnhancementCustom(instanceId, parsed, promise)
      } else {
        initializeOnlineEnhancementAuto(instanceId, parsed, promise)
      }
    } catch (e: Exception) {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        "Failed to initialize online enhancement: ${e.message}",
        e,
      )
    }
  }

  private fun initializeOnlineEnhancementCustom(
    instanceId: String,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        "custom init requires a concrete modelType",
      )
      return
    }
    if (modelTypeStr != "gtcrn" && modelTypeStr != "dpdfnet") {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        "Unsupported enhancement model type: $modelTypeStr",
      )
      return
    }

    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("enhancement", modelTypeStr, pathStrings)?.let { errorMsg ->
      promise.reject(EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR, errorMsg)
      return
    }

    finishInitializeOnlineWithModelPath(
      instanceId = instanceId,
      modelTypeStr = modelTypeStr,
      paths = pathStrings,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun initializeOnlineEnhancementAuto(
    instanceId: String,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    val result = nativeDetectEnhancementModel(modelDir, null, parsed.modelType)
    if (result == null || result["success"] as? Boolean != true) {
      val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
      promise.reject(EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR, reason)
      return
    }

    val modelTypeStr = EnhancementModelConfigFactory.extractModelType(result)
    val paths = EnhancementModelConfigFactory.extractPaths(result)
    finishInitializeOnlineWithModelPath(
      instanceId = instanceId,
      modelTypeStr = modelTypeStr,
      paths = paths,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun finishInitializeOnlineWithModelPath(
    instanceId: String,
    modelTypeStr: String,
    paths: Map<String, String>,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelConfig = try {
      EnhancementModelConfigFactory.build(
        modelTypeStr,
        paths,
        parsed.numThreads,
        parsed.provider,
        parsed.debug,
      )
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
      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker) {
        completion -> emitPipelineCompletedEvent(completion)
      }

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

  fun startEnhancementOfflineLivePipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    audioOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    try {
      val enhancer = instances[instanceId]?.denoiser
      if (enhancer == null) {
        promise.reject(EnhancementErrorCodes.ENHANCEMENT_ERROR, "Enhancement instance not found: $instanceId")
        return
      }
      val liveAudioIn = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (liveAudioIn == null) {
        promise.reject(EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND, "Input live buffer not found: $audioInLiveBufferId")
        return
      }
      val liveAudioOut = PipelineAudioRegistry.getLive(audioOutLiveBufferId)
      if (liveAudioOut == null) {
        promise.reject(EnhancementErrorCodes.ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND, "Output live buffer not found: $audioOutLiveBufferId")
        return
      }

      val attachedSegmentationEngineId = options.getString("attachedSegmentationEngineId")?.trim().orEmpty()
      if (attachedSegmentationEngineId.isEmpty()) {
        error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: attachedSegmentationEngineId missing on native bridge")
      }

      val segmentLiveBufferId = options.getString("segmentLiveBufferId")?.trim().orEmpty()
      if (segmentLiveBufferId.isEmpty()) {
        error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: segmentLiveBufferId missing on native bridge")
      }

      val segmentEntry = SegmentPipelineRegistry.getLive(segmentLiveBufferId)
        ?: error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: Segment buffer not found: $segmentLiveBufferId")

      val pipelineId = "live_offline_enh_${UUID.randomUUID()}"
      val worker = EnhancementOfflineLivePipelineWorker(
        pipelineId = pipelineId,
        attachedSegmentationEngineId = attachedSegmentationEngineId,
        audioInputRef = OfflineLivePipelineWorker.AudioInput(
          liveAudioEntry = liveAudioIn,
          liveSegmentEntry = segmentEntry,
        ),
        enhancer = enhancer,
        audioOutputEntry = liveAudioOut,
      )
      StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
      }
      promise.resolve(WritableNativeMap().apply { putString("pipelineId", pipelineId) })
    } catch (e: Exception) {
      val msg = e.message ?: "live offline enhancement failed"
      val code = if (msg.startsWith("LIVE_OFFLINE_SEGMENTATION_REQUIRED")) {
        "LIVE_OFFLINE_SEGMENTATION_REQUIRED"
      } else {
        EnhancementErrorCodes.STREAMING_PIPELINE_ERROR
      }
      promise.reject(
        code,
        msg,
        e,
      )
    }
  }

  private fun emitPipelineCompletedEvent(completion: StreamingPipelineCompletion) {
    try {
      val payload = Arguments.createMap().apply {
        putString("pipelineId", completion.pipelineId)
        putString("reason", completion.reason)
        putDouble("chunksProcessed", completion.chunksProcessed.toDouble())
        putDouble("unitsRead", completion.unitsRead.toDouble())
        putDouble("unitsWritten", completion.unitsWritten.toDouble())
        if (completion.error != null) {
          putString("error", completion.error)
        } else {
          putNull("error")
        }
      }

      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("streamingPipelineCompleted", payload)
    } catch (_: Exception) {
      // JS bridge might already be shutting down.
    }
  }
}
