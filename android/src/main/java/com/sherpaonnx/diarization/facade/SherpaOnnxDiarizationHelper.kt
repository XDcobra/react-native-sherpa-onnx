package com.sherpaonnx.diarization.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.diarization.core.DiarizationErrorCodes
import com.sherpaonnx.diarization.pipeline.DiarizationStreamingPipelineWorker
import com.sherpaonnx.segment.pipeline.SegmentPipelineException
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.segment.pipeline.SegmentRecord
import java.util.concurrent.Executors

internal class SherpaOnnxDiarizationHelper(
  @Suppress("UnusedPrivateProperty")
  private val context: ReactApplicationContext,
  private val nativeDetectDiarizationModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?,
) {
  private val executor = Executors.newSingleThreadExecutor()

  fun shutdown() {
    executor.shutdownNow()
  }

  fun detectDiarizationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise,
  ) {
    try {
      val result =
        nativeDetectDiarizationModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject(
          DiarizationErrorCodes.DETECT_ERROR,
          "Diarization model detection returned null",
        )
        return
      }
      promise.resolve(detectResultToWritable(result))
    } catch (e: Exception) {
      Log.e(DiarizationErrorCodes.TAG, "Diarization detection failed", e)
      promise.reject(
        DiarizationErrorCodes.DETECT_ERROR,
        "Diarization model detection failed: ${e.message}",
        e,
      )
    }
  }

  fun initializeDiarization(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_INIT_ERROR, "instanceId is required")
      return
    }
    val segmentationModel = options.getString("segmentationModel")?.trim().orEmpty()
    val embeddingModel = options.getString("embeddingModel")?.trim().orEmpty()
    if (segmentationModel.isEmpty() || embeddingModel.isEmpty()) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_INIT_ERROR,
        "segmentationModel and embeddingModel are required",
      )
      return
    }

    val windowShiftRatio = optDouble(options, "windowShiftRatio", 0.1)
    val numClusters = optDouble(options, "numClusters", -1.0).toInt()
    val threshold = optDouble(options, "threshold", 0.5).toFloat()
    val minDurationOn = optDouble(options, "minDurationOn", 0.3).toFloat()
    val minDurationOff = optDouble(options, "minDurationOff", 0.5).toFloat()
    val numThreads = optDouble(options, "numThreads", 1.0).toInt().coerceAtLeast(1)
    val provider = options.getString("provider")?.trim()?.takeIf { it.isNotEmpty() }
    val debug =
      options.hasKey("debug") && !options.isNull("debug") && options.getBoolean("debug")

    executor.execute {
      try {
        val result = nativeInitializeDiarization(
          instanceId,
          segmentationModel,
          embeddingModel,
          windowShiftRatio.toFloat(),
          numClusters,
          threshold,
          minDurationOn,
          minDurationOff,
          numThreads,
          provider,
          debug,
        )
        if (result == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_INIT_ERROR,
            "Diarization initialization returned null",
          )
          return@execute
        }
        val success = result["success"] as? Boolean ?: false
        if (!success) {
          val error = result["error"] as? String
          val errorCode = (result["errorCode"] as? String)?.takeIf { it.isNotBlank() }
            ?: DiarizationErrorCodes.DIARIZATION_INIT_ERROR
          Log.e(
            DiarizationErrorCodes.TAG,
            "initializeDiarization failed: instanceId=$instanceId error=$error",
          )
          promise.reject(
            errorCode,
            error?.takeIf { it.isNotBlank() } ?: "Failed to initialize diarization",
          )
          return@execute
        }
        Log.i(
          DiarizationErrorCodes.TAG,
          "initializeDiarization ok: instanceId=$instanceId sampleRate=${result["sampleRate"]}",
        )
        promise.resolve(initResultToWritable(result))
      } catch (e: Exception) {
        Log.e(DiarizationErrorCodes.TAG, "Failed to initialize diarization", e)
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_INIT_ERROR,
          "Failed to initialize diarization: ${e.message}",
          e,
        )
      }
    }
  }

  fun diarizeOffline(
    instanceId: String,
    audioInBufferId: String,
    segmentsOutBufferId: String,
    includeOverlap: Boolean,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "instanceId is required")
      return
    }
    if (audioInBufferId.isBlank()) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
        "audioInBufferId is required",
      )
      return
    }
    if (!audioInBufferId.startsWith("off_")) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_ERROR,
        "Expected offline audio buffer (off_*) for audioIn, got: $audioInBufferId",
      )
      return
    }
    if (segmentsOutBufferId.isBlank() || !segmentsOutBufferId.startsWith("seg_off_")) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_ERROR,
        "Expected empty offline segment buffer (seg_off_*) for segmentsOut, got: $segmentsOutBufferId",
      )
      return
    }

    executor.execute {
      try {
        val audioInEntry = PipelineAudioRegistry.getOffline(audioInBufferId)
        if (audioInEntry == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
            "Offline audio buffer not found: $audioInBufferId",
          )
          return@execute
        }
        if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_ERROR,
            "Input offline audio buffer is empty: $audioInBufferId",
          )
          return@execute
        }

        val offlineOut = SegmentPipelineRegistry.getOffline(segmentsOutBufferId)
        if (offlineOut == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
            "Offline segment buffer not found: $segmentsOutBufferId",
          )
          return@execute
        }
        if (offlineOut.snapshotSegments().isNotEmpty()) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_ERROR,
            "segmentOut must be an empty offline segment buffer",
          )
          return@execute
        }

        Log.i(
          DiarizationErrorCodes.TAG,
          "diarizeOffline: instanceId=$instanceId audioIn=$audioInBufferId " +
            "segmentsOut=$segmentsOutBufferId " +
            "numSamples=${audioInEntry.numSamples} sampleRate=${audioInEntry.sampleRate}",
        )
        val inputSamples = audioInEntry.readAllSamples()
        val result = nativeProcessDiarization(
          instanceId,
          inputSamples,
          audioInEntry.sampleRate,
          includeOverlap,
        )
        if (result == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_ERROR,
            "Diarization process returned null",
          )
          return@execute
        }
        val success = result["success"] as? Boolean ?: false
        if (!success) {
          val error = result["error"] as? String
          val errorCode = (result["errorCode"] as? String)?.takeIf { it.isNotBlank() }
            ?: DiarizationErrorCodes.DIARIZATION_ERROR
          val code =
            if (errorCode == DiarizationErrorCodes.DIARIZATION_CANCELLED ||
              error?.contains("cancel", ignoreCase = true) == true
            ) {
              DiarizationErrorCodes.DIARIZATION_CANCELLED
            } else {
              errorCode
            }
          promise.reject(
            code,
            error?.takeIf { it.isNotBlank() } ?: "Diarization process failed",
          )
          return@execute
        }

        val sampleRate =
          (result["sampleRate"] as? Number)?.toInt()?.takeIf { it > 0 }
            ?: audioInEntry.sampleRate
        @Suppress("UNCHECKED_CAST")
        val segments =
          result["segments"] as? ArrayList<HashMap<String, Any>> ?: arrayListOf()
        val records = ArrayList<SegmentRecord>(segments.size)
        for (seg in segments) {
          val startSec = (seg["start"] as? Number)?.toDouble() ?: 0.0
          val endSec = (seg["end"] as? Number)?.toDouble() ?: 0.0
          val speaker = (seg["speaker"] as? Number)?.toInt() ?: 0
          val startSample =
            kotlin.math
              .round(startSec * sampleRate)
              .toInt()
              .coerceAtLeast(0)
          val endSample =
            kotlin.math
              .round(endSec * sampleRate)
              .toInt()
              .coerceAtLeast(startSample)
          val durationMs =
            if (sampleRate > 0) {
              ((endSample - startSample) * 1000) / sampleRate
            } else {
              0
            }
          records.add(
            SegmentRecord(
              id = "seg_off_${startSample}_${endSample}",
              kind = "diarization",
              sourceAudioBufferId = audioInBufferId,
              startSample = startSample,
              endSample = endSample,
              sampleRate = sampleRate,
              durationMs = durationMs,
              confidence = null,
              payloadJson = """{"source":"diarization","speaker":$speaker}""",
            ),
          )
        }
        try {
          offlineOut.populate(records)
        } catch (e: SegmentPipelineException) {
          promise.reject(
            e.code,
            e.message ?: "Failed to populate offline segment buffer",
            e,
          )
          return@execute
        }

        promise.resolve(processResultToWritableWritten(result, records.size, sampleRate))
      } catch (e: Exception) {
        Log.e(DiarizationErrorCodes.TAG, "diarizeOffline failed", e)
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Failed to diarize audio: ${e.message}",
          e,
        )
      }
    }
  }

  fun reclusterDiarization(
    instanceId: String,
    numClusters: Double,
    threshold: Double,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "instanceId is required")
      return
    }
    executor.execute {
      try {
        val result = nativeReclusterDiarization(
          instanceId,
          numClusters.toInt(),
          threshold.toFloat(),
        )
        if (result == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_ERROR,
            "Diarization recluster returned null",
          )
          return@execute
        }
        val success = result["success"] as? Boolean ?: false
        if (!success) {
          val error = result["error"] as? String
          val errorCode = (result["errorCode"] as? String)?.takeIf { it.isNotBlank() }
            ?: DiarizationErrorCodes.DIARIZATION_NOT_INITIALIZED
          promise.reject(
            errorCode,
            error?.takeIf { it.isNotBlank() } ?: "Diarization recluster failed",
          )
          return@execute
        }
        promise.resolve(processResultToWritable(result))
      } catch (e: Exception) {
        Log.e(DiarizationErrorCodes.TAG, "reclusterDiarization failed", e)
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Failed to recluster: ${e.message}",
          e,
        )
      }
    }
  }

  fun getDiarizationClusterEmbeddings(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "instanceId is required")
      return
    }
    executor.execute {
      try {
        val list = nativeGetClusterEmbeddings(instanceId)
        if (list == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_NOT_INITIALIZED,
            "Diarization instance not found: $instanceId",
          )
          return@execute
        }
        val arr = Arguments.createArray()
        for (entry in list) {
          val map = Arguments.createMap()
          val speaker = entry["speaker"] as? Int ?: 0
          map.putInt("speaker", speaker)
          val embedding = entry["embedding"] as? FloatArray
          val embArr = Arguments.createArray()
          if (embedding != null) {
            for (v in embedding) {
              embArr.pushDouble(v.toDouble())
            }
          }
          map.putArray("embedding", embArr)
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        Log.e(DiarizationErrorCodes.TAG, "getDiarizationClusterEmbeddings failed", e)
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Failed to get cluster embeddings: ${e.message}",
          e,
        )
      }
    }
  }

  fun cancelDiarization(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.resolve(null)
      return
    }
    try {
      // Synchronous so AbortSignal can interrupt an in-flight process on the executor.
      nativeCancelDiarization(instanceId)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(DiarizationErrorCodes.TAG, "cancelDiarization failed", e)
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_ERROR,
        "Failed to cancel diarization: ${e.message}",
        e,
      )
    }
  }

  fun unloadDiarization(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.resolve(null)
      return
    }
    executor.execute {
      try {
        nativeUnloadDiarization(instanceId)
        promise.resolve(null)
      } catch (e: Exception) {
        Log.e(DiarizationErrorCodes.TAG, "unloadDiarization failed", e)
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Failed to unload diarization: ${e.message}",
          e,
        )
      }
    }
  }

  private fun optDouble(options: ReadableMap, key: String, default: Double): Double {
    if (!options.hasKey(key) || options.isNull(key)) return default
    return try {
      options.getDouble(key)
    } catch (_: Exception) {
      default
    }
  }

  private fun initResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val errorCode = result["errorCode"] as? String
    if (!errorCode.isNullOrBlank()) map.putString("errorCode", errorCode)
    val sampleRate = result["sampleRate"] as? Int
    if (sampleRate != null && sampleRate > 0) {
      map.putInt("sampleRate", sampleRate)
    }
    return map
  }

  private fun processResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val errorCode = result["errorCode"] as? String
    if (!errorCode.isNullOrBlank()) map.putString("errorCode", errorCode)

    val segmentsArr = Arguments.createArray()
    @Suppress("UNCHECKED_CAST")
    val segments = result["segments"] as? ArrayList<HashMap<String, Any>> ?: arrayListOf()
    for (seg in segments) {
      val m = Arguments.createMap()
      val start = (seg["start"] as? Number)?.toDouble() ?: 0.0
      val end = (seg["end"] as? Number)?.toDouble() ?: 0.0
      val speaker = (seg["speaker"] as? Number)?.toInt() ?: 0
      m.putDouble("start", start)
      m.putDouble("end", end)
      m.putInt("speaker", speaker)
      segmentsArr.pushMap(m)
    }
    map.putArray("segments", segmentsArr)

    val numSpeakers = (result["numSpeakers"] as? Number)?.toInt() ?: 0
    map.putInt("numSpeakers", numSpeakers)
    val sampleRate = (result["sampleRate"] as? Number)?.toInt() ?: 0
    map.putInt("sampleRate", sampleRate)

    @Suppress("UNCHECKED_CAST")
    val spf = result["speakersPerFrame"] as? ArrayList<*>
    if (!spf.isNullOrEmpty()) {
      val spfArr = Arguments.createArray()
      for (entry in spf) {
        val v = (entry as? Number)?.toInt() ?: continue
        spfArr.pushInt(v)
      }
      if (spfArr.size() > 0) {
        map.putArray("speakersPerFrame", spfArr)
      }
    }
    return map
  }

  /** Product diarize path: segments already written to segmentsOut; omit timeline array. */
  private fun processResultToWritableWritten(
    result: HashMap<String, Any>,
    segmentCount: Int,
    sampleRate: Int,
  ): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val errorCode = result["errorCode"] as? String
    if (!errorCode.isNullOrBlank()) map.putString("errorCode", errorCode)
    map.putArray("segments", Arguments.createArray())
    map.putInt("segmentCount", segmentCount)
    val numSpeakers = (result["numSpeakers"] as? Number)?.toInt() ?: 0
    map.putInt("numSpeakers", numSpeakers)
    map.putInt("sampleRate", sampleRate)

    @Suppress("UNCHECKED_CAST")
    val spf = result["speakersPerFrame"] as? ArrayList<*>
    if (!spf.isNullOrEmpty()) {
      val spfArr = Arguments.createArray()
      for (entry in spf) {
        val v = (entry as? Number)?.toInt() ?: continue
        spfArr.pushInt(v)
      }
      if (spfArr.size() > 0) {
        map.putArray("speakersPerFrame", spfArr)
      }
    }
    return map
  }

  private fun detectResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    map.putBoolean("isStreaming", result["isStreaming"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val mt = result["modelType"] as? String
    if (!mt.isNullOrBlank()) map.putString("modelType", mt)

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
      if (arr.size() > 0) map.putArray("languages", arr)
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
      if (arr.size() > 0) map.putArray("detectionSources", arr)
    }

    @Suppress("UNCHECKED_CAST")
    val paths = result["paths"] as? HashMap<String, Any?>
    if (paths != null) {
      val writablePaths = Arguments.createMap()
      val modelPath = paths["model"] as? String
      if (!modelPath.isNullOrBlank()) writablePaths.putString("model", modelPath)
      val metadataPath = paths["metadata"] as? String
      if (!metadataPath.isNullOrBlank()) writablePaths.putString("metadata", metadataPath)
      if (writablePaths.toHashMap().isNotEmpty()) {
        map.putMap("paths", writablePaths)
      }
    }

    return map
  }

  fun initializeStreamingDiarization(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_INIT_ERROR, "instanceId is required")
      return
    }
    val model = options.getString("model")?.trim().orEmpty()
    if (model.isEmpty()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_INIT_ERROR, "model path is required")
      return
    }
    val metadata = options.getString("metadata")?.trim()?.takeIf { it.isNotEmpty() }
    val numThreads = optDouble(options, "numThreads", 1.0).toInt().coerceAtLeast(1)
    val provider = options.getString("provider")?.trim()?.takeIf { it.isNotEmpty() }
    val debug = options.hasKey("debug") && !options.isNull("debug") && options.getBoolean("debug")
    val onset = optDouble(options, "onset", 0.5).toFloat()
    val offset = optDouble(options, "offset", 0.5).toFloat()
    val padOnset = optDouble(options, "padOnset", 0.0).toFloat()
    val padOffset = optDouble(options, "padOffset", 0.0).toFloat()
    val minDurationOn = optDouble(options, "minDurationOn", 0.0).toFloat()
    val minDurationOff = optDouble(options, "minDurationOff", 0.5).toFloat()
    val medianWindow = optDouble(options, "medianWindow", 11.0).toInt().coerceAtLeast(1)

    executor.execute {
      try {
        val result = nativeInitializeStreamingDiarization(
          instanceId,
          model,
          metadata,
          numThreads,
          provider,
          debug,
          onset,
          offset,
          padOnset,
          padOffset,
          minDurationOn,
          minDurationOff,
          medianWindow,
        )
        if (result == null) {
          promise.reject(
            DiarizationErrorCodes.DIARIZATION_INIT_ERROR,
            "Streaming diarization initialization returned null",
          )
          return@execute
        }
        val success = result["success"] as? Boolean ?: false
        if (!success) {
          val error = result["error"] as? String
          val errorCode = (result["errorCode"] as? String)?.takeIf { it.isNotBlank() }
            ?: DiarizationErrorCodes.DIARIZATION_INIT_ERROR
          promise.reject(errorCode, error?.takeIf { it.isNotBlank() } ?: "Failed to initialize streaming diarization")
          return@execute
        }
        val map = Arguments.createMap()
        map.putBoolean("success", true)
        (result["sampleRate"] as? Number)?.toInt()?.let { map.putInt("sampleRate", it) }
        (result["maxSpeakers"] as? Number)?.toInt()?.let { map.putInt("maxSpeakers", it) }
        (result["feedSamples"] as? Number)?.toInt()?.let { map.putInt("feedSamples", it) }
        (result["strideSamples"] as? Number)?.toInt()?.let { map.putInt("strideSamples", it) }
        (result["latencySeconds"] as? Number)?.toDouble()?.let { map.putDouble("latencySeconds", it) }
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_INIT_ERROR,
          "Failed to initialize streaming diarization: ${e.message}",
          e,
        )
      }
    }
  }

  fun startStreamingDiarizationPipeline(
    instanceId: String,
    audioInBufferId: String,
    segmentsOutBufferId: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "instanceId is required")
      return
    }
    if (audioInBufferId.isBlank() || !audioInBufferId.startsWith("live_")) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
        "Expected live audio buffer (live_*) for audioIn, got: $audioInBufferId",
      )
      return
    }
    if (segmentsOutBufferId.isBlank() || !segmentsOutBufferId.startsWith("seg_live_")) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
        "Expected live segment buffer (seg_live_*) for segmentsOut, got: $segmentsOutBufferId",
      )
      return
    }

    val inEntry = PipelineAudioRegistry.getLive(audioInBufferId)
    val outEntry = SegmentPipelineRegistry.getLive(segmentsOutBufferId)
    if (inEntry == null || outEntry == null) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
        "Input or output buffer not found",
      )
      return
    }

    val chunkSize = options?.takeIf { it.hasKey("chunkSize") && !it.isNull("chunkSize") }
      ?.getDouble("chunkSize")?.toInt() ?: 4096

    try {
      var workerRef: DiarizationStreamingPipelineWorker? = null
      val worker = DiarizationStreamingPipelineWorker(
        instanceId = instanceId,
        inputEntry = inEntry,
        outputEntry = outEntry,
        chunkSize = chunkSize,
        feedNative = { chunk -> nativeFeedStreamingDiarization(instanceId, chunk) },
        flushNative = { nativeFlushStreamingDiarization(instanceId) },
        resetNative = { nativeResetStreamingDiarization(instanceId) },
        emitEvent = { type, payload ->
          emitStreamingEvent(instanceId, workerRef?.pipelineId ?: "", type, payload)
        },
      )
      workerRef = worker

      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
      }
      val map = Arguments.createMap()
      map.putString("pipelineId", pipelineId)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_ERROR,
        "Failed to start streaming diarization pipeline: ${e.message}",
        e,
      )
    }
  }

  fun feedStreamingDiarization(
    instanceId: String,
    audioInBufferId: String,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "instanceId is required")
      return
    }
    val inEntry = PipelineAudioRegistry.getOffline(audioInBufferId)
    if (inEntry == null) {
      promise.reject(
        DiarizationErrorCodes.DIARIZATION_BUFFER_NOT_FOUND,
        "Audio buffer not found: $audioInBufferId",
      )
      return
    }

    executor.execute {
      try {
        val inputSamples = inEntry.readAllSamples()
        val result = nativeFeedStreamingDiarization(instanceId, inputSamples)
        if (result == null) {
          promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "Feed returned null")
          return@execute
        }
        promise.resolve(processFeedResultToWritable(result))
      } catch (e: Exception) {
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Feed failed: ${e.message}",
          e,
        )
      }
    }
  }

  fun flushStreamingDiarization(instanceId: String, promise: Promise) {
    executor.execute {
      try {
        val result = nativeFlushStreamingDiarization(instanceId)
        if (result == null) {
          promise.reject(DiarizationErrorCodes.DIARIZATION_ERROR, "Flush returned null")
          return@execute
        }
        promise.resolve(processFeedResultToWritable(result))
      } catch (e: Exception) {
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Flush failed: ${e.message}",
          e,
        )
      }
    }
  }

  fun resetStreamingDiarization(instanceId: String, promise: Promise) {
    executor.execute {
      try {
        nativeResetStreamingDiarization(instanceId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Reset failed: ${e.message}",
          e,
        )
      }
    }
  }

  fun releaseStreamingDiarization(instanceId: String, promise: Promise) {
    executor.execute {
      try {
        nativeReleaseStreamingDiarization(instanceId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(
          DiarizationErrorCodes.DIARIZATION_ERROR,
          "Release failed: ${e.message}",
          e,
        )
      }
    }
  }

  private fun emitPipelineCompletedEvent(completion: com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion) {
    if (!context.hasActiveReactInstance()) return
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

  private fun emitStreamingEvent(
    instanceId: String,
    pipelineId: String,
    type: String,
    payload: Map<String, Any?>,
  ) {
    if (!context.hasActiveReactInstance()) return
    val map = Arguments.createMap()
    map.putString("instanceId", instanceId)
    map.putString("pipelineId", pipelineId)
    map.putString("type", type)
    val dataMap = Arguments.createMap()
    payload.forEach { (k, v) ->
      when (v) {
        is Number -> dataMap.putDouble(k, v.toDouble())
        is String -> dataMap.putString(k, v)
        is Boolean -> dataMap.putBoolean(k, v)
      }
    }
    map.putMap("data", dataMap)
    context
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("SherpaOnnxDiarizationEvent", map)
  }

  private fun processFeedResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val errorCode = result["errorCode"] as? String
    if (!errorCode.isNullOrBlank()) map.putString("errorCode", errorCode)

    val segmentsArr = Arguments.createArray()
    @Suppress("UNCHECKED_CAST")
    val segments = result["segments"] as? ArrayList<HashMap<String, Any>> ?: arrayListOf()
    for (seg in segments) {
      val m = Arguments.createMap()
      val start = (seg["start"] as? Number)?.toDouble() ?: 0.0
      val end = (seg["end"] as? Number)?.toDouble() ?: 0.0
      val speaker = (seg["speaker"] as? Number)?.toInt() ?: 0
      m.putDouble("start", start)
      m.putDouble("end", end)
      m.putInt("speaker", speaker)
      segmentsArr.pushMap(m)
    }
    map.putArray("segments", segmentsArr)
    return map
  }

  private companion object {
    @JvmStatic
    private external fun nativeInitializeStreamingDiarization(
      instanceId: String,
      modelPath: String,
      metadataPath: String?,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
      onset: Float,
      offset: Float,
      padOnset: Float,
      padOffset: Float,
      minDurationOn: Float,
      minDurationOff: Float,
      medianWindow: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeFeedStreamingDiarization(
      instanceId: String,
      samples: FloatArray?,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeFlushStreamingDiarization(
      instanceId: String,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeResetStreamingDiarization(
      instanceId: String,
    )

    @JvmStatic
    private external fun nativeReleaseStreamingDiarization(
      instanceId: String,
    )

    @JvmStatic
    private external fun nativeInitializeDiarization(
      instanceId: String,
      segmentationModelPath: String,
      embeddingModelPath: String,
      windowShiftRatio: Float,
      numClusters: Int,
      threshold: Float,
      minDurationOn: Float,
      minDurationOff: Float,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeProcessDiarization(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
      includeOverlap: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeReclusterDiarization(
      instanceId: String,
      numClusters: Int,
      threshold: Float,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeGetClusterEmbeddings(
      instanceId: String,
    ): ArrayList<HashMap<String, Any>>?

    @JvmStatic
    private external fun nativeCancelDiarization(instanceId: String)

    @JvmStatic
    private external fun nativeUnloadDiarization(instanceId: String)
  }
}
