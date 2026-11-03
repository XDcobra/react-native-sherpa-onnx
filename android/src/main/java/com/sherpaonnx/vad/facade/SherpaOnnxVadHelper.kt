package com.sherpaonnx.vad.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.lifecycle.ActivePipelineStop
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.segment.pipeline.SegmentRecord
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.vad.config.VadInitOptionsParser
import com.sherpaonnx.vad.core.VadErrorCodes
import com.sherpaonnx.vad.core.VadInstanceConfig
import com.sherpaonnx.vad.core.VadRuntime
import com.sherpaonnx.vad.core.VadRuntimeOptions
import com.sherpaonnx.vad.core.VadSegment
import com.sherpaonnx.vad.core.defaultRuntimeOptions
import com.sherpaonnx.vad.core.withRuntimeOverrides
import com.sherpaonnx.vad.pipeline.VadPipelineWorker
import java.util.concurrent.ConcurrentHashMap

class SherpaOnnxVadHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectVadModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
    quantization: String?
  ) -> HashMap<String, Any>?
) {
  private val instances = ConcurrentHashMap<String, VadInstanceConfig>()
  private val instancePipeline = ConcurrentHashMap<String, String>()
  private val workers = ConcurrentHashMap<String, VadPipelineWorker>()

  companion object {
    private const val TAG = "SherpaOnnx:vad"

    /**
     * Ephemeral JNI VAD for segmentation engines (speech_vad_model policy).
     * Caller must [VadRuntime.close] which unloads the native instance.
     */
    fun createVadRuntime(
      modelType: String,
      modelPath: String,
      sampleRate: Int,
      provider: String,
      numThreads: Int,
      debug: Boolean,
      runtimeOptions: VadRuntimeOptions,
    ): VadRuntime {
      val instanceId = "vad_seg_${java.util.UUID.randomUUID()}"
      @Suppress("UNCHECKED_CAST")
      val raw = nativeInitialize(
        instanceId,
        modelType,
        modelPath,
        sampleRate,
        numThreads,
        provider,
        debug,
        runtimeOptions.scoreThreshold,
        runtimeOptions.minSilenceDurationMs,
        runtimeOptions.minSpeechDurationMs,
        runtimeOptions.maxSpeechDurationMs,
        runtimeOptions.windowSize,
        30.0f,
      ) as? HashMap<String, Any>
      val ok = raw?.get("success") as? Boolean ?: false
      if (!ok) {
        val err = raw?.get("error") as? String ?: "Failed to initialize VAD runtime"
        throw IllegalStateException(err)
      }
      return NativeVadRuntime(instanceId, unloadOnClose = true)
    }

    @JvmStatic
    private external fun nativeInitialize(
      instanceId: String,
      modelType: String,
      modelPath: String,
      sampleRate: Int,
      numThreads: Int,
      provider: String,
      debug: Boolean,
      threshold: Double,
      minSilenceMs: Int,
      minSpeechMs: Int,
      maxSpeechMs: Int,
      windowSize: Int,
      bufferSizeSeconds: Float,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeAcceptWaveform(instanceId: String, samples: FloatArray)

    @JvmStatic
    private external fun nativeFlush(instanceId: String)

    @JvmStatic
    private external fun nativeReset(instanceId: String)

    @JvmStatic
    private external fun nativeIsSpeechDetected(instanceId: String): Boolean

    @JvmStatic
    private external fun nativePopSegments(instanceId: String): ArrayList<HashMap<String, Any>>?

    @JvmStatic
    private external fun nativeHasInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnload(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }

  private class NativeVadRuntime(
    private val instanceId: String,
    private val unloadOnClose: Boolean = false,
  ) : VadRuntime {
    @Volatile private var closed = false

    @Synchronized
    override fun acceptWaveform(chunk: FloatArray) {
      if (closed) return
      nativeAcceptWaveform(instanceId, chunk)
    }

    @Synchronized
    override fun flush() {
      if (closed) return
      nativeFlush(instanceId)
    }

    @Synchronized
    override fun reset() {
      if (closed) return
      nativeReset(instanceId)
    }

    @Synchronized
    override fun isSpeechDetected(): Boolean {
      if (closed) return false
      return nativeIsSpeechDetected(instanceId)
    }

    @Synchronized
    override fun popSegments(): List<VadSegment> {
      if (closed) return emptyList()
      val raw = nativePopSegments(instanceId) ?: return emptyList()
      val out = ArrayList<VadSegment>(raw.size)
      for (item in raw) {
        val start = (item["startSample"] as? Number)?.toInt() ?: 0
        val end = (item["endSample"] as? Number)?.toInt() ?: start
        val durationMs = (item["durationMs"] as? Number)?.toInt() ?: 0
        out.add(VadSegment(startSample = start, endSample = end, durationMs = durationMs))
      }
      return out
    }

    @Synchronized
    override fun close() {
      if (closed) return
      closed = true
      if (unloadOnClose) {
        try {
          nativeUnload(instanceId)
        } catch (_: Exception) {
        }
      }
    }
  }

  private fun releaseRuntimeSafely(cfg: VadInstanceConfig, where: String) {
    val gateKey = cfg.gateKey()
    val inFlight = NativeInstanceGate.inFlight(gateKey)
    if (inFlight > 0) {
      Log.w(TAG, "UNLOAD_DURING_COMPUTE where=$where instanceId=${cfg.instanceId} inFlight=$inFlight")
    }
    NativeInstanceGate.releaseWhenIdle(gateKey) {
      try {
        nativeUnload(cfg.instanceId)
      } catch (_: Exception) {
      }
      try {
        cfg.runtime.close()
      } catch (_: Exception) {
      }
    }
  }

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
    val pipelineId = ActivePipelineStop.stopForInstance(
      instanceId = instanceId,
      activeByInstance = instancePipeline,
      removeFromRegistry = true,
    ) ?: return null
    try {
      workers[pipelineId]?.stop()
    } catch (_: Exception) {
    }
    workers.remove(pipelineId)
    return pipelineId
  }

  fun detectVadModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    quantization: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectVadModel(modelDir, assetName, modelType ?: "auto", quantization)
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
      val quantizationOut = result["quantization"] as? String
      if (!quantizationOut.isNullOrBlank()) map.putString("quantization", quantizationOut)
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
    val parsed = VadInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        VadErrorCodes.MODEL_INIT_FAILED,
        if (options?.hasKey("initMode") == true && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        }
      )
      return
    }
    try {
      if (parsed.initMode == "custom") {
        initializeVadCustom(instanceId, parsed, promise)
      } else {
        initializeVadAuto(instanceId, parsed, promise)
      }
    } catch (e: Exception) {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "Failed to initialize VAD runtime: ${e.message}", e)
    }
  }

  private fun initializeVadCustom(
    instanceId: String,
    parsed: VadInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "custom init requires a concrete modelType")
      return
    }
    if (modelTypeStr != "silero_vad" && modelTypeStr != "ten_vad") {
      promise.reject(
        VadErrorCodes.MODEL_INIT_FAILED,
        "Unsupported VAD model type: $modelTypeStr",
      )
      return
    }

    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("vad", modelTypeStr, pathStrings)?.let { errorMsg ->
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, errorMsg)
      return
    }

    val modelPath = pathStrings["model"].orEmpty()
    finishInitializeWithModelPath(
      instanceId = instanceId,
      modelDir = "custom",
      resolvedModelType = modelTypeStr,
      modelPath = modelPath,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun initializeVadAuto(
    instanceId: String,
    parsed: VadInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    val detect = nativeDetectVadModel(modelDir, null, parsed.modelType, parsed.quantization)
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
    finishInitializeWithModelPath(
      instanceId = instanceId,
      modelDir = modelDir,
      resolvedModelType = resolvedModelType,
      modelPath = modelPath,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun finishInitializeWithModelPath(
    instanceId: String,
    modelDir: String,
    resolvedModelType: String,
    modelPath: String,
    parsed: VadInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val baseRuntime = defaultRuntimeOptions(resolvedModelType)
    val runtimeOptions = withRuntimeOverrides(
      base = baseRuntime,
      scoreThreshold = parsed.threshold,
      minSpeechDurationMs = parsed.minSpeechDurationMs,
      minSilenceDurationMs = parsed.minSilenceDurationMs,
      windowSize = parsed.windowSize,
      maxSpeechDurationMs = parsed.maxSpeechDurationMs,
    )
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

    instances.remove(instanceId)?.let { old ->
      stopAndRemovePipelineForInstance(instanceId)
      releaseRuntimeSafely(old, where = "reinit:$instanceId")
    }

    @Suppress("UNCHECKED_CAST")
    val raw = nativeInitialize(
      instanceId,
      resolvedModelType,
      modelPath,
      parsed.sampleRate,
      parsed.numThreads,
      parsed.provider,
      parsed.debug,
      strictRuntimeOptions.scoreThreshold,
      strictRuntimeOptions.minSilenceDurationMs,
      strictRuntimeOptions.minSpeechDurationMs,
      strictRuntimeOptions.maxSpeechDurationMs,
      strictRuntimeOptions.windowSize,
      30.0f,
    ) as? HashMap<String, Any>
    val ok = raw?.get("success") as? Boolean ?: false
    if (!ok) {
      val err = raw?.get("error") as? String ?: "Failed to initialize VAD runtime"
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, err)
      return
    }

    instances[instanceId] = VadInstanceConfig(
      instanceId = instanceId,
      modelType = resolvedModelType,
      modelDir = modelDir,
      sampleRate = parsed.sampleRate,
      provider = parsed.provider,
      numThreads = parsed.numThreads,
      debug = parsed.debug,
      runtimeOptions = strictRuntimeOptions,
      runtime = NativeVadRuntime(instanceId),
    )
    promise.resolve(null)
  }

  fun startVadPipeline(instanceId: String, audioInBufferId: String, segmentOutBufferId: String, options: ReadableMap?, promise: Promise) {
    val cfg = instances[instanceId]
    if (cfg == null || !nativeHasInstance(instanceId)) {
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

  fun runVadOffline(
    instanceId: String,
    audioInBufferId: String,
    segmentOutBufferId: String,
    @Suppress("UNUSED_PARAMETER") options: ReadableMap?,
    promise: Promise,
  ) {
    val cfg = instances[instanceId]
    if (cfg == null || !nativeHasInstance(instanceId)) {
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
    val samples = audio.readAllSamples()
    val gateKey = cfg.gateKey()
    if (!NativeInstanceGate.beginUse(gateKey)) {
      promise.reject(VadErrorCodes.MODEL_INIT_FAILED, "VAD instance released: $instanceId")
      return
    }
    val stats = try {
      runAcceptFlushPopSegmentation(
        cfg = cfg,
        samples = samples,
        sourceAudioBufferId = audioInBufferId,
        liveOut = liveOut,
        records = records,
      )
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }
    if (offlineOut != null) {
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

  /** iOS-aligned offline path: windowed AcceptWaveform → Flush → PopSegments. */
  private fun runAcceptFlushPopSegmentation(
    cfg: VadInstanceConfig,
    samples: FloatArray,
    sourceAudioBufferId: String,
    liveOut: com.sherpaonnx.segment.pipeline.LiveSegmentEntry?,
    records: MutableList<SegmentRecord>,
  ): OfflineInferenceStats {
    val frameSize = cfg.runtimeOptions.windowSize.coerceAtLeast(1)
    cfg.runtime.reset()
    var idx = 0
    var chunksProcessed = 0
    while (idx < samples.size) {
      val end = minOf(idx + frameSize, samples.size)
      var chunk = samples.copyOfRange(idx, end)
      if (chunk.size < frameSize) {
        chunk = chunk.copyOf(frameSize)
      }
      cfg.runtime.acceptWaveform(chunk)
      chunksProcessed += 1
      idx = end
    }
    cfg.runtime.flush()
    val segments = cfg.runtime.popSegments()
    var speechDurationMs = 0L
    for (segment in segments) {
      appendSegmentRecord(
        records,
        liveOut,
        sourceAudioBufferId,
        cfg,
        segment.startSample,
        segment.endSample,
        1.0,
      )
      speechDurationMs += segment.durationMs.toLong()
    }
    return OfflineInferenceStats(
      chunksProcessed = chunksProcessed,
      segmentCount = segments.size,
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
    if (worker != null) {
      promise.resolve(worker.isSpeechDetectedNow())
      return
    }
    if (nativeHasInstance(instanceId)) {
      promise.resolve(nativeIsSpeechDetected(instanceId))
      return
    }
    promise.resolve(false)
  }

  fun unloadVad(instanceId: String, promise: Promise) {
    stopAndRemovePipelineForInstance(instanceId)
    val instance = instances.remove(instanceId)
    if (instance != null) {
      releaseRuntimeSafely(instance, where = "unload:$instanceId")
    } else {
      nativeUnload(instanceId)
    }
    promise.resolve(null)
  }

  fun shutdown() {
    val pipelineIds = mutableSetOf<String>()
    pipelineIds.addAll(instancePipeline.values)
    pipelineIds.addAll(workers.keys)
    pipelineIds.forEach { stopAndRemovePipelineInternal(it) }
    for ((id, cfg) in instances) {
      releaseRuntimeSafely(cfg, where = "shutdown:$id")
    }
    instances.clear()
    instancePipeline.clear()
    workers.clear()
    nativeShutdownAll()
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
