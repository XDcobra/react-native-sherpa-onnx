package com.sherpaonnx.enhancement.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
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
import com.sherpaonnx.enhancement.core.EnhancementResultMapper
import com.sherpaonnx.enhancement.core.NativeEnhanceAudio
import com.sherpaonnx.enhancement.core.OnlineEnhancementInstance
import com.sherpaonnx.enhancement.pipeline.EnhancementOfflineLivePipelineWorker
import com.sherpaonnx.enhancement.pipeline.EnhancementPipelineWorker
import com.sherpaonnx.lifecycle.ActivePipelineStop
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxEnhancementHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectEnhancementModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
    quantization: String?
  ) -> HashMap<String, Any>?,
) {
  private val instances = ConcurrentHashMap<String, EnhancementInstance>()
  private val onlineInstances = ConcurrentHashMap<String, OnlineEnhancementInstance>()
  private val activeLivePipelineByInstance = ConcurrentHashMap<String, String>()
  private val activeOnlinePipelineByInstance = ConcurrentHashMap<String, String>()

  private fun stopActiveLivePipeline(instanceId: String) {
    ActivePipelineStop.stopForInstance(
      instanceId = instanceId,
      activeByInstance = activeLivePipelineByInstance,
      removeFromRegistry = false,
    )
  }

  private fun stopActiveOnlinePipeline(instanceId: String) {
    ActivePipelineStop.stopForInstance(
      instanceId = instanceId,
      activeByInstance = activeOnlinePipelineByInstance,
      removeFromRegistry = true,
    )
  }

  fun shutdown() {
    for (id in activeLivePipelineByInstance.keys.toList()) {
      stopActiveLivePipeline(id)
    }
    for (id in activeOnlinePipelineByInstance.keys.toList()) {
      stopActiveOnlinePipeline(id)
    }
    for (inst in instances.values.toList()) {
      NativeInstanceGate.releaseWhenIdle(inst.gateKey()) {
        try {
          nativeUnloadOffline(inst.instanceId)
        } catch (_: Exception) {
        }
      }
    }
    instances.clear()
    for (inst in onlineInstances.values.toList()) {
      NativeInstanceGate.releaseWhenIdle(inst.gateKey()) {
        try {
          nativeUnloadOnline(inst.instanceId)
        } catch (_: Exception) {
        }
      }
    }
    onlineInstances.clear()
    nativeShutdownAll()
  }

  fun detectEnhancementModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    quantization: String?,
    promise: Promise,
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, assetName, modelType ?: "auto", quantization)
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
    if (modelTypeStr != "gtcrn" && modelTypeStr != "dpdfnet" && modelTypeStr != "voxlock") {
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

    val result = nativeInitializeOfflineCustom(
      instanceId,
      modelTypeStr,
      HashMap(pathStrings),
      parsed.numThreads.toInt().coerceAtLeast(1),
      parsed.provider,
      parsed.debug,
    )
    resolveOfflineInit(instanceId, result, promise)
  }

  private fun initializeEnhancementAuto(
    instanceId: String,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    if (modelDir.isBlank()) {
      promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, "modelDir is required for initMode auto")
      return
    }
    val result = nativeInitializeOfflineAuto(
      instanceId,
      modelDir,
      parsed.modelType,
      parsed.numThreads.toInt().coerceAtLeast(1),
      parsed.provider,
      parsed.debug,
    )
    resolveOfflineInit(instanceId, result, promise)
  }

  private fun resolveOfflineInit(
    instanceId: String,
    result: HashMap<String, Any>?,
    promise: Promise,
  ) {
    if (result == null) {
      promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, "Enhancement initialize returned null")
      return
    }
    if (result["success"] as? Boolean != true) {
      val error = (result["error"] as? String)?.takeIf { it.isNotBlank() }
        ?: "Failed to initialize enhancement"
      promise.reject(EnhancementErrorCodes.ENHANCEMENT_INIT_ERROR, error)
      return
    }
    instances[instanceId] = EnhancementInstance(instanceId)
    val out = Arguments.createMap()
    out.putBoolean("success", true)
    out.putArray(
      "detectedModels",
      EnhancementResultMapper.detectedModelsToWritableArray(
        result["detectedModels"] as? ArrayList<*>
      ),
    )
    out.putString("modelType", (result["modelType"] as? String) ?: "unknown")
    out.putInt("sampleRate", (result["sampleRate"] as? Number)?.toInt() ?: 0)
    promise.resolve(out)
  }

  fun enhanceOfflineAudioBuffers(
    instanceId: String,
    audioInBufferId: String,
    audioOutBufferId: String,
    promise: Promise,
  ) {
    val inst = instances[instanceId]
    if (inst == null) {
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
      val gateKey = inst.gateKey()
      if (!NativeInstanceGate.beginUse(gateKey)) {
        promise.reject(
          EnhancementErrorCodes.ENHANCEMENT_ERROR,
          "Enhancement instance released: $instanceId",
        )
        return
      }
      val audio = try {
        runOffline(instanceId, inputSamples, audioInEntry.sampleRate)
      } finally {
        NativeInstanceGate.endUse(gateKey)
      }
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

  fun setVoiceSample(
    instanceId: String,
    bufferId: String,
    promise: Promise,
  ) {
    val offlineInst = instances[instanceId]
    val onlineInst = onlineInstances[instanceId]
    if (offlineInst == null && onlineInst == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Enhancement instance not found: $instanceId",
      )
      return
    }

    if (!bufferId.startsWith("off_")) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) for voice sample, got: $bufferId",
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(bufferId)
    if (audioInEntry == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $bufferId",
      )
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_BUFFER_EMPTY,
        "Input offline audio buffer is empty: $bufferId",
      )
      return
    }

    try {
      val inputSamples = audioInEntry.readAllSamples()
      if (inputSamples.isEmpty()) {
        promise.reject(
          EnhancementErrorCodes.ENHANCEMENT_BUFFER_EMPTY,
          "Input offline audio buffer is empty: $bufferId",
        )
        return
      }
      val gateKey = offlineInst?.gateKey() ?: onlineInst!!.gateKey()
      if (!NativeInstanceGate.beginUse(gateKey)) {
        promise.reject(
          EnhancementErrorCodes.ENHANCEMENT_ERROR,
          "Enhancement instance released: $instanceId",
        )
        return
      }
      val result = try {
        nativeSetVoiceSample(instanceId, inputSamples, audioInEntry.sampleRate)
      } finally {
        NativeInstanceGate.endUse(gateKey)
      }
      if (result == null || result["success"] as? Boolean != true) {
        val error = (result?.get("error") as? String)?.takeIf { it.isNotBlank() }
          ?: "Failed to set VoxLock voice sample"
        promise.reject(EnhancementErrorCodes.ENHANCEMENT_INVALID_ARGUMENT, error)
        return
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Failed to set VoxLock voice sample: ${e.message}",
        e,
      )
    }
  }

  fun getSampleRate(instanceId: String, promise: Promise) {
    if (instances[instanceId] == null && onlineInstances[instanceId] == null) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Enhancement instance not found: $instanceId",
      )
      return
    }
    val sampleRate = nativeGetSampleRate(instanceId)
    if (sampleRate <= 0) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_ERROR,
        "Enhancement instance not found: $instanceId",
      )
      return
    }
    promise.resolve(sampleRate)
  }

  fun unloadEnhancement(instanceId: String, promise: Promise) {
    stopActiveLivePipeline(instanceId)
    val inst = instances.remove(instanceId)
    if (inst != null) {
      NativeInstanceGate.releaseWhenIdle(inst.gateKey()) {
        try {
          nativeUnloadOffline(instanceId)
        } catch (_: Exception) {
        }
      }
    }
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
    if (modelTypeStr != "gtcrn" && modelTypeStr != "dpdfnet" && modelTypeStr != "voxlock") {
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

    val result = nativeInitializeOnlineCustom(
      instanceId,
      modelTypeStr,
      HashMap(pathStrings),
      parsed.numThreads.toInt().coerceAtLeast(1),
      parsed.provider,
      parsed.debug,
    )
    resolveOnlineInit(instanceId, result, promise)
  }

  private fun initializeOnlineEnhancementAuto(
    instanceId: String,
    parsed: EnhancementInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    if (modelDir.isBlank()) {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        "modelDir is required for initMode auto",
      )
      return
    }
    val result = nativeInitializeOnlineAuto(
      instanceId,
      modelDir,
      parsed.modelType,
      parsed.numThreads.toInt().coerceAtLeast(1),
      parsed.provider,
      parsed.debug,
    )
    resolveOnlineInit(instanceId, result, promise)
  }

  private fun resolveOnlineInit(
    instanceId: String,
    result: HashMap<String, Any>?,
    promise: Promise,
  ) {
    if (result == null) {
      promise.reject(
        EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR,
        "Online enhancement initialize returned null",
      )
      return
    }
    if (result["success"] as? Boolean != true) {
      val error = (result["error"] as? String)?.takeIf { it.isNotBlank() }
        ?: "Failed to initialize online enhancement"
      promise.reject(EnhancementErrorCodes.ONLINE_ENHANCEMENT_INIT_ERROR, error)
      return
    }
    onlineInstances[instanceId] = OnlineEnhancementInstance(instanceId)
    val out = Arguments.createMap()
    out.putBoolean("success", true)
    out.putString("modelType", (result["modelType"] as? String) ?: "unknown")
    out.putInt("sampleRate", (result["sampleRate"] as? Number)?.toInt() ?: 0)
    out.putInt("frameShiftInSamples", (result["frameShiftInSamples"] as? Number)?.toInt() ?: 0)
    promise.resolve(out)
  }

  fun startEnhancementPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    audioOutLiveBufferId: String,
    promise: Promise,
  ) {
    if (onlineInstances[instanceId] == null) {
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

    val denoiserSampleRate = nativeGetSampleRate(instanceId)
    if (inputEntry.sampleRate != denoiserSampleRate) {
      promise.reject(
        EnhancementErrorCodes.ENHANCEMENT_PIPELINE_SAMPLE_RATE_MISMATCH,
        "Input buffer sample rate (${inputEntry.sampleRate}) does not match denoiser sample rate ($denoiserSampleRate)",
      )
      return
    }

    try {
      stopActiveOnlinePipeline(instanceId)
      val worker = EnhancementPipelineWorker(instanceId, inputEntry, outputEntry)
      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        activeOnlinePipelineByInstance.remove(instanceId, completion.pipelineId)
        emitPipelineCompletedEvent(completion)
      }
      activeOnlinePipelineByInstance[instanceId] = pipelineId

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
    stopActiveOnlinePipeline(instanceId)
    val inst = onlineInstances.remove(instanceId)
    if (inst != null) {
      NativeInstanceGate.releaseWhenIdle(inst.gateKey()) {
        try {
          nativeUnloadOnline(instanceId)
        } catch (_: Exception) {
        }
      }
    }
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
      if (instances[instanceId] == null) {
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
      stopActiveLivePipeline(instanceId)
      val worker = EnhancementOfflineLivePipelineWorker(
        pipelineId = pipelineId,
        attachedSegmentationEngineId = attachedSegmentationEngineId,
        audioInputRef = OfflineLivePipelineWorker.AudioInput(
          liveAudioEntry = liveAudioIn,
          liveSegmentEntry = segmentEntry,
        ),
        instanceId = instanceId,
        audioOutputEntry = liveAudioOut,
      )
      activeLivePipelineByInstance[instanceId] = pipelineId
      StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        activeLivePipelineByInstance.remove(instanceId, pipelineId)
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

  companion object {
    private fun parseAudio(result: HashMap<String, Any>?): NativeEnhanceAudio {
      if (result == null || result["success"] as? Boolean != true) {
        val error = (result?.get("error") as? String)?.takeIf { it.isNotBlank() }
          ?: "Enhancement run failed"
        throw IllegalStateException(error)
      }
      val samples = result["samples"] as? FloatArray ?: FloatArray(0)
      val sampleRate = (result["sampleRate"] as? Number)?.toInt() ?: 0
      return NativeEnhanceAudio(samples, sampleRate)
    }

    fun runOffline(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): NativeEnhanceAudio = parseAudio(nativeOfflineRun(instanceId, samples, sampleRate))

    fun runOnline(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): NativeEnhanceAudio = parseAudio(nativeOnlineRun(instanceId, samples, sampleRate))

    fun flushOnline(instanceId: String): NativeEnhanceAudio =
      parseAudio(nativeOnlineFlush(instanceId))

    fun resetOnline(instanceId: String) {
      nativeOnlineReset(instanceId)
    }

    fun sampleRate(instanceId: String): Int = nativeGetSampleRate(instanceId)

    fun frameShift(instanceId: String): Int = nativeGetFrameShift(instanceId)

    @JvmStatic
    private external fun nativeInitializeOfflineAuto(
      instanceId: String,
      modelDir: String,
      modelType: String,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeInitializeOfflineCustom(
      instanceId: String,
      modelType: String,
      modelPaths: HashMap<String, String>,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeInitializeOnlineAuto(
      instanceId: String,
      modelDir: String,
      modelType: String,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeInitializeOnlineCustom(
      instanceId: String,
      modelType: String,
      modelPaths: HashMap<String, String>,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeSetVoiceSample(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeOfflineRun(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeOnlineRun(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeOnlineFlush(instanceId: String): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeOnlineReset(instanceId: String)

    @JvmStatic
    private external fun nativeGetSampleRate(instanceId: String): Int

    @JvmStatic
    private external fun nativeGetFrameShift(instanceId: String): Int

    @JvmStatic
    private external fun nativeUnloadOffline(instanceId: String)

    @JvmStatic
    private external fun nativeUnloadOnline(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }
}
