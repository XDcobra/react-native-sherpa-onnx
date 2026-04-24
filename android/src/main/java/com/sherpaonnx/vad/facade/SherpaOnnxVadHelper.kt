package com.sherpaonnx.vad.facade

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.segment.pipeline.SegmentRecord
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.vad.core.VadErrorCodes
import com.sherpaonnx.vad.core.VadInstanceConfig
import com.sherpaonnx.vad.core.VadRuntimeOptions
import com.sherpaonnx.vad.core.createVadRuntime
import com.sherpaonnx.vad.core.defaultRuntimeOptions
import com.sherpaonnx.vad.core.withRuntimeOverrides
import com.sherpaonnx.vad.pipeline.VadPipelineWorker
import java.util.concurrent.ConcurrentHashMap

class SherpaOnnxVadHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectVadModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String
  ) -> HashMap<String, Any>?
) {
  private val instances = ConcurrentHashMap<String, VadInstanceConfig>()
  private val instancePipeline = ConcurrentHashMap<String, String>()
  private val workers = ConcurrentHashMap<String, VadPipelineWorker>()

  private fun stopAndRemovePipelineInternal(pipelineId: String): String? {
    val worker = workers[pipelineId]
    try {
      worker?.stop()
    } catch (_: Exception) {
    }
    try {
      StreamingPipelineRegistry.stop(pipelineId)
    } catch (_: Exception) {
    }
    try {
      StreamingPipelineRegistry.remove(pipelineId)
    } catch (_: Exception) {
    }
    workers.remove(pipelineId)
    var removedInstanceId: String? = null
    instancePipeline.entries.removeIf { entry ->
      val match = entry.value == pipelineId
      if (match) {
        removedInstanceId = entry.key
      }
      match
    }
    return removedInstanceId
  }

  private fun stopAndRemovePipelineForInstance(instanceId: String): String? {
    val pipelineId = instancePipeline[instanceId] ?: return null
    return stopAndRemovePipelineInternal(pipelineId)
  }

  fun detectVadModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectVadModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject(VadErrorCodes.INTERNAL_ERROR, "VAD model detection returned null")
        return
      }
      val map = Arguments.createMap()
      map.putBoolean("success", result["success"] as? Boolean ?: false)
      val error = result["error"] as? String
      if (!error.isNullOrBlank()) map.putString("error", error)
      val mt = result["modelType"] as? String
      if (!mt.isNullOrBlank()) map.putString("modelType", mt)
      map.putBoolean("isStreaming", result["isStreaming"] as? Boolean ?: false)
      val models = Arguments.createArray()
      @Suppress("UNCHECKED_CAST")
      val detected = result["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
      for (entry in detected) {
        val m = Arguments.createMap()
        m.putString("type", entry["type"] ?: "")
        m.putString("modelDir", entry["modelDir"] ?: "")
        models.pushMap(m)
      }
      map.putArray("detectedModels", models)
      val languages = result["languages"] as? ArrayList<*>
      if (!languages.isNullOrEmpty()) {
        val arr = Arguments.createArray()
        for (entry in languages) {
          val value = entry as? String
          if (!value.isNullOrBlank()) arr.pushString(value)
        }
        map.putArray("languages", arr)
      }
      val quantization = result["quantization"] as? String
      if (!quantization.isNullOrBlank()) map.putString("quantization", quantization)
      val detectionSources = result["detectionSources"] as? ArrayList<*>
      if (!detectionSources.isNullOrEmpty()) {
        val arr = Arguments.createArray()
        for (entry in detectionSources) {
          val value = entry as? String
          if (!value.isNullOrBlank()) arr.pushString(value)
        }
        map.putArray("detectionSources", arr)
      }
      @Suppress("UNCHECKED_CAST")
      val paths = result["paths"] as? HashMap<String, Any?>
      if (paths != null) {
        val writablePaths = Arguments.createMap()
        val modelPath = paths["model"] as? String
        if (!modelPath.isNullOrBlank()) writablePaths.putString("model", modelPath)
        map.putMap("paths", writablePaths)
      }
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject(VadErrorCodes.INTERNAL_ERROR, "VAD model detection failed: ${e.message}", e)
    }
  }

  fun initializeVad(instanceId: String, options: ReadableMap?, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.reject(VadErrorCodes.INVALID_ARGUMENT, "instanceId is required")
      return
    }
    val sampleRate = options?.takeIf { it.hasKey("sampleRate") && !it.isNull("sampleRate") }?.getDouble("sampleRate")?.toInt()
      ?: 16000
    val threshold = options?.takeIf { it.hasKey("threshold") && !it.isNull("threshold") }?.getDouble("threshold")
    val minSpeech = options?.takeIf { it.hasKey("minSpeechDurationMs") && !it.isNull("minSpeechDurationMs") }?.getDouble("minSpeechDurationMs")?.toInt()
      ?: options?.takeIf { it.hasKey("speechDurationMs") && !it.isNull("speechDurationMs") }?.getDouble("speechDurationMs")?.toInt()
      ?: 250
    val minSilence = options?.takeIf { it.hasKey("silenceDurationMs") && !it.isNull("silenceDurationMs") }?.getDouble("silenceDurationMs")?.toInt()
      ?: 250
    val windowSize = options?.takeIf { it.hasKey("windowSize") && !it.isNull("windowSize") }?.getDouble("windowSize")?.toInt()
    val maxSpeechDurationMs = options
      ?.takeIf { it.hasKey("maxSpeechDurationS") && !it.isNull("maxSpeechDurationS") }
      ?.getDouble("maxSpeechDurationS")
      ?.times(1000.0)
      ?.toInt()
    val provider = options?.takeIf { it.hasKey("provider") && !it.isNull("provider") }?.getString("provider")
      ?: "cpu"
    val numThreads = options?.takeIf { it.hasKey("numThreads") && !it.isNull("numThreads") }?.getDouble("numThreads")?.toInt()
      ?: 1
    val debug = options?.takeIf { it.hasKey("debug") && !it.isNull("debug") }?.getBoolean("debug") ?: false
    val modelDir = options?.takeIf { it.hasKey("modelDir") && !it.isNull("modelDir") }?.getString("modelDir")
    val requestedModelType = options?.takeIf { it.hasKey("modelType") && !it.isNull("modelType") }?.getString("modelType")
      ?: "auto"
    if (modelDir.isNullOrBlank()) {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "modelDir is required for VAD initialization")
      return
    }
    try {
      val detect = nativeDetectVadModel(modelDir, null, requestedModelType)
      val ok = detect?.get("success") as? Boolean ?: false
      if (!ok) {
        val reason = detect?.get("error") as? String ?: "Failed to detect VAD model"
        promise.reject(VadErrorCodes.MODEL_INIT_FAILED, reason)
        return
      }
      val resolvedModelType = (detect["modelType"] as? String)?.trim().orEmpty()
      if (resolvedModelType != "silero_vad" && resolvedModelType != "ten_vad") {
        promise.reject(
          VadErrorCodes.MODEL_INIT_FAILED,
          "Unsupported VAD model type: $resolvedModelType",
        )
        return
      }
      @Suppress("UNCHECKED_CAST")
      val detectedPaths = detect["paths"] as? HashMap<String, Any?>
      val modelPath = (detectedPaths?.get("model") as? String)?.takeIf { it.isNotBlank() } ?: modelDir
      val baseRuntime = defaultRuntimeOptions(resolvedModelType)
      val runtimeOptions = withRuntimeOverrides(
        base = baseRuntime,
        scoreThreshold = threshold,
        minSpeechDurationMs = minSpeech,
        minSilenceDurationMs = minSilence,
        windowSize = windowSize,
        maxSpeechDurationMs = maxSpeechDurationMs,
      )
      // Enforce strict model/options pairing.
      val strictRuntimeOptions = when (resolvedModelType) {
        "silero_vad" -> (runtimeOptions as? VadRuntimeOptions.Silero)
        "ten_vad" -> (runtimeOptions as? VadRuntimeOptions.Ten)
        else -> null
      }
      if (strictRuntimeOptions == null) {
        promise.reject(
          VadErrorCodes.MODEL_INIT_FAILED,
          "VAD runtime options mismatch for model type: $resolvedModelType",
        )
        return
      }
      val runtime = createVadRuntime(
        modelType = resolvedModelType,
        modelPath = modelPath,
        sampleRate = sampleRate,
        provider = provider,
        numThreads = numThreads,
        debug = debug,
        runtimeOptions = strictRuntimeOptions,
      )
      instances[instanceId] = VadInstanceConfig(
        modelType = resolvedModelType,
        modelDir = modelDir,
        sampleRate = sampleRate,
        provider = provider,
        numThreads = numThreads,
        debug = debug,
        runtimeOptions = strictRuntimeOptions,
        runtime = runtime,
      )
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "Failed to initialize VAD runtime: ${e.message}", e)
    }
  }

  fun startVadPipeline(instanceId: String, audioInBufferId: String, segmentOutBufferId: String, options: ReadableMap?, promise: Promise) {
    val cfg = instances[instanceId]
    if (cfg == null) {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "VAD instance not initialized: $instanceId")
      return
    }
    val oldPid = instancePipeline[instanceId]
    if (oldPid != null) {
      stopAndRemovePipelineInternal(oldPid)
    }
    if (!audioInBufferId.startsWith("live_")) {
      promise.reject(VadErrorCodes.BUFFER_KIND_MISMATCH, "audioInBufferId must be a live audio buffer")
      return
    }
    if (!segmentOutBufferId.startsWith("seg_live_")) {
      promise.reject(VadErrorCodes.BUFFER_KIND_MISMATCH, "segmentOutBufferId must be a live segment buffer")
      return
    }
    val inEntry = PipelineAudioRegistry.getLive(audioInBufferId)
    val outEntry = SegmentPipelineRegistry.getLive(segmentOutBufferId)
    if (inEntry == null || outEntry == null) {
      promise.reject(VadErrorCodes.BUFFER_NOT_FOUND, "Input/output buffer not found")
      return
    }
    val chunkSize = options?.takeIf { it.hasKey("chunkSize") && !it.isNull("chunkSize") }?.getDouble("chunkSize")?.toInt()
      ?: 512
    var workerRef: VadPipelineWorker? = null
    val worker = VadPipelineWorker(
      instanceId = instanceId,
      inputEntry = inEntry,
      outputEntry = outEntry,
      config = cfg,
      chunkSize = chunkSize,
      emitEvent = { type, payload -> emitVadEvent(instanceId, workerRef?.pipelineId ?: "", type, payload) }
    )
    workerRef = worker
    // Register instance->pipeline before startup so early events are correlated.
    instancePipeline[instanceId] = worker.pipelineId
    val pipelineId = StreamingPipelineRegistry.registerAndStart(worker)
    workers[pipelineId] = worker
    if (pipelineId != worker.pipelineId) {
      instancePipeline[instanceId] = pipelineId
    }
    val map = Arguments.createMap()
    map.putString("pipelineId", pipelineId)
    promise.resolve(map)
  }

  fun runVadOffline(instanceId: String, audioInBufferId: String, segmentOutBufferId: String, options: ReadableMap?, promise: Promise) {
    val cfg = instances[instanceId]
    if (cfg == null) {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "VAD instance not initialized: $instanceId")
      return
    }
    if (!audioInBufferId.startsWith("off_")) {
      promise.reject(VadErrorCodes.BUFFER_KIND_MISMATCH, "audioInBufferId must be an offline audio buffer")
      return
    }
    val audio = PipelineAudioRegistry.getOffline(audioInBufferId)
    if (audio == null) {
      promise.reject(VadErrorCodes.BUFFER_NOT_FOUND, "Offline audio buffer not found: $audioInBufferId")
      return
    }
    val offlineOut = if (segmentOutBufferId.startsWith("seg_off_")) SegmentPipelineRegistry.getOffline(segmentOutBufferId) else null
    val liveOut = if (segmentOutBufferId.startsWith("seg_live_")) SegmentPipelineRegistry.getLive(segmentOutBufferId) else null
    if (offlineOut == null && liveOut == null) {
      promise.reject(VadErrorCodes.BUFFER_NOT_FOUND, "Segment output buffer not found: $segmentOutBufferId")
      return
    }
    val records = mutableListOf<SegmentRecord>()
    val chunkSize = options?.takeIf { it.hasKey("chunkSize") && !it.isNull("chunkSize") }?.getDouble("chunkSize")?.toInt() ?: 512
    val samples = audio.readAllSamples()
    cfg.runtime.reset()
    val stats = runModelInferenceSegmentation(
      cfg = cfg,
      samples = samples,
      chunkSize = chunkSize,
      sourceAudioBufferId = audioInBufferId,
      liveOut = liveOut,
      records = records,
    )
    if (offlineOut != null) {
      // Fill exactly once for empty offline output buffers.
      offlineOut.populate(records)
    }
    val out = Arguments.createMap().apply {
      putDouble("chunksProcessed", stats.chunksProcessed.toDouble())
      putDouble("unitsRead", samples.size.toDouble())
      putDouble("unitsWritten", stats.segmentCount.toDouble())
      putDouble("segmentCount", stats.segmentCount.toDouble())
      putDouble("speechDurationMs", stats.speechDurationMs.toDouble())
    }
    promise.resolve(out)
  }

  private data class OfflineInferenceStats(
    val chunksProcessed: Int,
    val segmentCount: Int,
    val speechDurationMs: Long,
  )

  private fun runModelInferenceSegmentation(
    cfg: VadInstanceConfig,
    samples: FloatArray,
    chunkSize: Int,
    sourceAudioBufferId: String,
    liveOut: com.sherpaonnx.segment.pipeline.LiveSegmentEntry?,
    records: MutableList<SegmentRecord>,
  ): OfflineInferenceStats {
    var idx = 0
    var inSpeech = false
    var segStart = 0
    var speechSamples = 0
    var silenceSamples = 0
    var speechDurationMs = 0L
    var segmentCount = 0
    var chunksProcessed = 0
    var speechScoreSum = 0.0
    var speechScoreCount = 0
    while (idx < samples.size) {
      val end = minOf(idx + chunkSize, samples.size)
      val chunk = samples.copyOfRange(idx, end)
      chunksProcessed += 1
      val decision = cfg.runtime.infer(chunk, cfg.sampleRate)
      if (decision.isSpeech) {
        if (!inSpeech) {
          inSpeech = true
          segStart = idx
          speechSamples = 0
          silenceSamples = 0
          speechScoreSum = 0.0
          speechScoreCount = 0
        }
        speechSamples += (end - idx)
        silenceSamples = 0
        if (decision.score != null) {
          speechScoreSum += decision.score
          speechScoreCount += 1
        }
      } else if (inSpeech) {
        silenceSamples += (end - idx)
        val silenceMs = ((silenceSamples.toLong() * 1000L) / cfg.sampleRate.toLong()).toInt()
        if (silenceMs >= cfg.runtimeOptions.minSilenceDurationMs) {
          val segmentEnd = segStart + speechSamples
          val dMs = ((speechSamples.toLong() * 1000L) / cfg.sampleRate.toLong())
          if (dMs >= cfg.runtimeOptions.minSpeechDurationMs.toLong()) {
            val confidence = if (speechScoreCount > 0) speechScoreSum / speechScoreCount.toDouble() else 1.0
            appendSegmentRecord(records, liveOut, sourceAudioBufferId, cfg, segStart, segmentEnd, confidence)
            speechDurationMs += dMs
            segmentCount += 1
          }
          inSpeech = false
          speechSamples = 0
          silenceSamples = 0
          speechScoreSum = 0.0
          speechScoreCount = 0
        }
      }
      idx = end
    }
    if (inSpeech && speechSamples > 0) {
      val segmentEnd = segStart + speechSamples
      val dMs = ((speechSamples.toLong() * 1000L) / cfg.sampleRate.toLong())
      if (dMs >= cfg.runtimeOptions.minSpeechDurationMs.toLong()) {
        val confidence = if (speechScoreCount > 0) speechScoreSum / speechScoreCount.toDouble() else 1.0
        appendSegmentRecord(records, liveOut, sourceAudioBufferId, cfg, segStart, segmentEnd, confidence)
        speechDurationMs += dMs
        segmentCount += 1
      }
    }
    return OfflineInferenceStats(
      chunksProcessed = chunksProcessed,
      segmentCount = segmentCount,
      speechDurationMs = speechDurationMs,
    )
  }

  private fun appendSegmentRecord(
    records: MutableList<SegmentRecord>,
    liveTarget: com.sherpaonnx.segment.pipeline.LiveSegmentEntry?,
    sourceAudioBufferId: String,
    cfg: VadInstanceConfig,
    start: Int,
    end: Int,
    confidence: Double,
  ) {
    val durationMs = ((end - start) * 1000) / cfg.sampleRate
    if (liveTarget != null) {
      liveTarget.appendSegment(
        "speech",
        sourceAudioBufferId,
        start,
        end,
        cfg.sampleRate,
        durationMs,
        confidence,
        """{"source":"vad","engine":"vad","decision":"model","score":$confidence}"""
      )
    } else {
      records.add(
        SegmentRecord(
          id = "seg_off_${start}_${end}",
          kind = "speech",
          sourceAudioBufferId = sourceAudioBufferId,
          startSample = start,
          endSample = end,
          sampleRate = cfg.sampleRate,
          durationMs = durationMs,
          confidence = confidence,
          payloadJson = """{"source":"vad","engine":"vad","decision":"model","score":$confidence}"""
        )
      )
    }
  }

  fun flushVad(pipelineId: String, promise: Promise) = StreamingPipelineRegistry.flush(pipelineId).whenComplete { _, err ->
    if (err != null) promise.reject(VadErrorCodes.INTERNAL_ERROR, err.message, err) else promise.resolve(null)
  }
  fun resetVad(pipelineId: String, promise: Promise) = StreamingPipelineRegistry.reset(pipelineId).whenComplete { _, err ->
    if (err != null) promise.reject(VadErrorCodes.INTERNAL_ERROR, err.message, err) else promise.resolve(null)
  }
  fun stopVadPipeline(pipelineId: String, promise: Promise) {
    val knownByWorker = workers.containsKey(pipelineId)
    val knownByInstance = instancePipeline.containsValue(pipelineId)
    val knownByRegistry = StreamingPipelineRegistry.getStatus(pipelineId) != null
    if (!knownByWorker && !knownByInstance && !knownByRegistry) {
      promise.reject(VadErrorCodes.PIPELINE_NOT_FOUND, "VAD pipeline not found: $pipelineId")
      return
    }
    stopAndRemovePipelineInternal(pipelineId)
    promise.resolve(null)
  }

  fun getVadPipelineStatus(pipelineId: String, promise: Promise) {
    val status = StreamingPipelineRegistry.getStatus(pipelineId)
    if (status == null) {
      promise.reject(VadErrorCodes.PIPELINE_NOT_FOUND, "VAD pipeline not found: $pipelineId")
      return
    }
    val map = Arguments.createMap().apply {
      putString("pipelineId", pipelineId)
      putBoolean("isRunning", status.isRunning)
      putBoolean("isFlushing", false)
      putInt("queueDepth", workers[pipelineId]?.queueDepthNow() ?: 0)
      putDouble("chunksProcessed", status.chunksProcessed.toDouble())
      putDouble("unitsRead", status.unitsRead.toDouble())
      putDouble("unitsWritten", status.unitsWritten.toDouble())
      if (status.error.isNullOrBlank()) putNull("error") else putString("error", status.error)
    }
    promise.resolve(map)
  }

  fun isVadSpeechDetected(instanceId: String, promise: Promise) {
    val pipelineId = instancePipeline[instanceId]
    val worker = if (pipelineId == null) null else workers[pipelineId]
    promise.resolve(worker?.isSpeechDetectedNow() ?: false)
  }

  fun unloadVad(instanceId: String, promise: Promise) {
    stopAndRemovePipelineForInstance(instanceId)
    val instance = instances.remove(instanceId)
    try {
      instance?.runtime?.close()
    } catch (_: Exception) {
    }
    promise.resolve(null)
  }

  fun shutdown() {
    val pipelineIds = mutableSetOf<String>()
    pipelineIds.addAll(instancePipeline.values)
    pipelineIds.addAll(workers.keys)
    pipelineIds.forEach { stopAndRemovePipelineInternal(it) }
    instances.values.forEach {
      try {
        it.runtime.close()
      } catch (_: Exception) {
      }
    }
    instances.clear()
    instancePipeline.clear()
    workers.clear()
  }

  private fun emitVadEvent(instanceId: String, pipelineId: String, type: String, payload: Map<String, Any?>) {
    try {
      val body = Arguments.createMap().apply {
        putString("type", type)
        putString("instanceId", instanceId)
        val effectivePipelineId = pipelineId.ifBlank { instancePipeline[instanceId] ?: "" }
        putString("pipelineId", effectivePipelineId)
        putDouble("ts", System.currentTimeMillis().toDouble())
        payload.forEach { (k, v) ->
          when (v) {
            null -> putNull(k)
            is String -> putString(k, v)
            is Boolean -> putBoolean(k, v)
            is Int -> putInt(k, v)
            is Long -> putDouble(k, v.toDouble())
            is Float -> putDouble(k, v.toDouble())
            is Double -> putDouble(k, v)
            else -> putString(k, v.toString())
          }
        }
      }
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("vadEvent", body)
    } catch (_: Exception) {
    }
  }
}
