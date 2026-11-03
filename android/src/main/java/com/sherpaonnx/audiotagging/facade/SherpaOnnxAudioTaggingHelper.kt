package com.sherpaonnx.audiotagging.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.audiotagging.config.AudioTaggingInitOptionsParser
import com.sherpaonnx.audiotagging.core.AudioTaggingErrorCodes
import com.sherpaonnx.audiotagging.core.AudioTaggingInstance
import com.sherpaonnx.audiotagging.core.AudioTaggingModelConfigFactory
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.lifecycle.ActivePipelineStop
import com.sherpaonnx.lifecycle.NativeInstanceGate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

internal class SherpaOnnxAudioTaggingHelper(
  private val nativeDetectAudioTaggingModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
    quantization: String?
  ) -> HashMap<String, Any>?,
) {
  private sealed class ResolveResult {
    data class Ok(val modelType: String, val paths: Map<String, String>) : ResolveResult()
    data class Err(val code: String, val message: String) : ResolveResult()
  }

  private val executor = Executors.newSingleThreadExecutor()
  private val instances = ConcurrentHashMap<String, AudioTaggingInstance>()
  private val activeLivePipelineByInstance = ConcurrentHashMap<String, String>()

  fun getInstance(instanceId: String): AudioTaggingInstance? = instances[instanceId]

  fun hasInstance(instanceId: String): Boolean =
    instances.containsKey(instanceId) && nativeHasInstance(instanceId)

  fun trackLivePipeline(instanceId: String, pipelineId: String) {
    activeLivePipelineByInstance[instanceId] = pipelineId
  }

  fun clearLivePipeline(instanceId: String, pipelineId: String) {
    activeLivePipelineByInstance.remove(instanceId, pipelineId)
  }

  fun stopActiveLivePipeline(instanceId: String) {
    ActivePipelineStop.stopForInstance(
      instanceId = instanceId,
      activeByInstance = activeLivePipelineByInstance,
      removeFromRegistry = false,
    )
  }

  fun shutdown() {
    for (id in activeLivePipelineByInstance.keys.toList()) {
      stopActiveLivePipeline(id)
    }
    executor.shutdownNow()
    for ((id, instance) in instances) {
      releaseTaggerSafely(instance, where = "shutdown:$id")
    }
    instances.clear()
    nativeShutdownAll()
  }

  private fun releaseTaggerSafely(inst: AudioTaggingInstance, where: String) {
    val gateKey = inst.gateKey()
    val inFlight = NativeInstanceGate.inFlight(gateKey)
    if (inFlight > 0) {
      Log.w(
        AudioTaggingErrorCodes.TAG,
        "UNLOAD_DURING_COMPUTE where=$where instanceId=${inst.instanceId} " +
          "gateKey=$gateKey inFlight=$inFlight",
      )
    }
    val released = NativeInstanceGate.releaseWhenIdle(gateKey) {
      try {
        nativeUnload(inst.instanceId)
      } catch (e: Exception) {
        Log.w(
          AudioTaggingErrorCodes.TAG,
          "unload.releaseError where=$where instanceId=${inst.instanceId} msg=${e.message}",
        )
      }
    }
    Log.d(
      AudioTaggingErrorCodes.TAG,
      "unload.releaseWhenIdle where=$where instanceId=${inst.instanceId} " +
        "nativeReleased=$released inFlightWas=$inFlight",
    )
  }

  /**
   * Compute without acquiring [NativeInstanceGate] — caller must already hold the gate
   * (live pipeline worker).
   */
  internal fun computeForLive(
    instanceId: String,
    samples: FloatArray,
    sampleRate: Int,
    topK: Int,
  ): List<Map<String, Any>> {
    @Suppress("UNCHECKED_CAST")
    val raw = nativeCompute(instanceId, samples, sampleRate, topK) as? HashMap<String, Any>
      ?: throw IllegalStateException("nativeCompute returned null")
    val success = raw["success"] as? Boolean ?: false
    if (!success) {
      val err = raw["error"] as? String ?: "compute failed"
      throw IllegalStateException(err)
    }
    @Suppress("UNCHECKED_CAST")
    val events = raw["events"] as? List<*>
    return mapEvents(events)
  }

  private fun mapEvents(events: List<*>?): List<Map<String, Any>> {
    if (events == null) return emptyList()
    val out = ArrayList<Map<String, Any>>(events.size)
    for (item in events) {
      @Suppress("UNCHECKED_CAST")
      val map = item as? Map<String, Any> ?: continue
      val name = map["name"] as? String ?: ""
      val index = (map["index"] as? Number)?.toInt() ?: 0
      val prob = (map["prob"] as? Number)?.toDouble() ?: 0.0
      out.add(mapOf("name" to name, "index" to index, "prob" to prob))
    }
    return out
  }

  fun initializeAudioTagging(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(AudioTaggingErrorCodes.INIT_ERROR, "instanceId is required")
      return
    }
    val parsed = AudioTaggingInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        AudioTaggingErrorCodes.INIT_ERROR,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        },
      )
      return
    }

    executor.execute {
      try {
        when (val resolved = if (parsed.initMode == "custom") {
          resolveCustom(parsed)
        } else {
          resolveAuto(parsed)
        }) {
          is ResolveResult.Err -> {
            promise.reject(resolved.code, resolved.message)
            return@execute
          }
          is ResolveResult.Ok -> {
            instances.remove(instanceId)?.let { old ->
              releaseTaggerSafely(old, where = "reinit:$instanceId")
            }

            val modelPath = resolved.paths["model"].orEmpty()
            val labelsPath = resolved.paths["labels"].orEmpty()
            Log.d(
              AudioTaggingErrorCodes.TAG,
              "init branch=${parsed.initMode} instanceId=$instanceId modelType=${resolved.modelType} " +
                "topK=${parsed.topK} model=$modelPath labels=$labelsPath",
            )

            @Suppress("UNCHECKED_CAST")
            val raw = nativeInitialize(
              instanceId,
              resolved.modelType,
              modelPath,
              labelsPath,
              parsed.topK,
              parsed.numThreads,
              parsed.provider ?: "cpu",
              parsed.debug,
            ) as? HashMap<String, Any>
            val success = raw?.get("success") as? Boolean ?: false
            if (!success) {
              val err = raw?.get("error") as? String ?: "Failed to initialize audio tagging"
              promise.reject(AudioTaggingErrorCodes.INIT_ERROR, err)
              return@execute
            }

            instances[instanceId] =
              AudioTaggingInstance(instanceId = instanceId, defaultTopK = parsed.topK)

            val result = Arguments.createMap()
            result.putBoolean("success", true)
            result.putString("modelType", resolved.modelType)
            promise.resolve(result)
          }
        }
      } catch (e: OutOfMemoryError) {
        Log.e(AudioTaggingErrorCodes.TAG, "OOM initializing audio tagging", e)
        promise.reject(
          AudioTaggingErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("audio-tagging"),
          e,
        )
      } catch (e: Exception) {
        Log.e(AudioTaggingErrorCodes.TAG, "Failed to initialize audio tagging", e)
        promise.reject(
          AudioTaggingErrorCodes.INIT_ERROR,
          "Failed to initialize audio tagging: ${e.message}",
          e,
        )
      }
    }
  }

  private fun resolveCustom(parsed: AudioTaggingInitOptionsParser.Parsed): ResolveResult {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      return ResolveResult.Err(
        AudioTaggingErrorCodes.INIT_ERROR,
        "custom init requires a concrete modelType (ced|zipformer)",
      )
    }
    if (modelTypeStr != "ced" && modelTypeStr != "zipformer") {
      return ResolveResult.Err(
        AudioTaggingErrorCodes.INIT_ERROR,
        "Unsupported audio tagging model type: $modelTypeStr",
      )
    }
    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("audiotagging", modelTypeStr, pathStrings)?.let { errorMsg ->
      return ResolveResult.Err(AudioTaggingErrorCodes.INIT_ERROR, errorMsg)
    }
    return ResolveResult.Ok(modelTypeStr, pathStrings)
  }

  private fun resolveAuto(parsed: AudioTaggingInitOptionsParser.Parsed): ResolveResult {
    val modelDir = parsed.modelDir.orEmpty()
    val result = nativeDetectAudioTaggingModel(
      modelDir,
      null,
      parsed.modelType,
      parsed.quantization,
    )
    if (result == null || result["success"] as? Boolean != true) {
      val reason = result?.get("error") as? String ?: "Failed to detect audio tagging model"
      return ResolveResult.Err(AudioTaggingErrorCodes.INIT_ERROR, reason)
    }
    val modelTypeStr = AudioTaggingModelConfigFactory.extractModelType(result)
    if (modelTypeStr != "ced" && modelTypeStr != "zipformer") {
      return ResolveResult.Err(
        AudioTaggingErrorCodes.INIT_ERROR,
        "Detected unsupported audio tagging model type: $modelTypeStr",
      )
    }
    val paths = AudioTaggingModelConfigFactory.extractPaths(result)
    return ResolveResult.Ok(modelTypeStr, paths)
  }

  fun tagAudioOffline(
    instanceId: String,
    audioBufferId: String,
    topK: Double?,
    startSample: Double?,
    endSample: Double?,
    promise: Promise,
  ) {
    val instance = instances[instanceId]
    if (instance == null || !nativeHasInstance(instanceId)) {
      promise.reject(
        AudioTaggingErrorCodes.NOT_INITIALIZED,
        "Audio tagging instance not found: $instanceId",
      )
      return
    }

    val audioEntry = PipelineAudioRegistry.getOffline(audioBufferId)
    if (audioEntry == null) {
      promise.reject(
        AudioTaggingErrorCodes.BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioBufferId",
      )
      return
    }
    if (audioEntry.numSamples == 0) {
      promise.reject(
        AudioTaggingErrorCodes.BUFFER_EMPTY,
        "Offline audio buffer is empty: $audioBufferId",
      )
      return
    }

    val hasStart = startSample != null
    val hasEnd = endSample != null
    if (hasStart != hasEnd) {
      promise.reject(
        AudioTaggingErrorCodes.INVALID_ARGUMENT,
        "startSample and endSample must both be provided or both omitted",
      )
      return
    }

    val effectiveTopK = (topK?.toInt() ?: instance.defaultTopK).coerceAtLeast(1)

    executor.execute {
      try {
        val t0 = SystemClock.uptimeMillis()
        val sampleRate = audioEntry.sampleRate
        val samples: FloatArray
        if (!hasStart) {
          samples = audioEntry.readAllSamples()
        } else {
          val start = kotlin.math.floor(startSample!!).toInt().coerceAtLeast(0)
          val endRaw = kotlin.math.floor(endSample!!).toInt().coerceAtLeast(start)
          val end = endRaw.coerceAtMost(audioEntry.numSamples)
          val frameCount = (end - start).coerceAtLeast(0)
          if (frameCount == 0) {
            val result = Arguments.createMap()
            result.putArray("events", Arguments.createArray())
            result.putDouble("audioDuration", 0.0)
            result.putDouble("elapsedMs", 0.0)
            result.putInt("topK", effectiveTopK)
            promise.resolve(result)
            return@execute
          }
          samples = audioEntry.readSlice(start, frameCount)
          Log.d(
            AudioTaggingErrorCodes.TAG,
            "tagOffline slice instanceId=$instanceId bufferId=$audioBufferId " +
              "startSample=$start endSample=$end frameCount=$frameCount",
          )
        }
        val audioDuration =
          if (sampleRate > 0) samples.size.toDouble() / sampleRate.toDouble() else 0.0

        Log.d(
          AudioTaggingErrorCodes.TAG,
          "tagOffline instanceId=$instanceId bufferId=$audioBufferId " +
            "sampleRate=$sampleRate numSamples=${samples.size} topK=$effectiveTopK",
        )

        val gateKey = instance.gateKey()
        if (!NativeInstanceGate.beginUse(gateKey)) {
          promise.reject(
            AudioTaggingErrorCodes.NOT_INITIALIZED,
            "Audio tagging instance released: $instanceId",
          )
          return@execute
        }

        val events: List<Map<String, Any>>
        try {
          @Suppress("UNCHECKED_CAST")
          val raw = nativeCompute(instanceId, samples, sampleRate, effectiveTopK)
            as? HashMap<String, Any>
            ?: throw IllegalStateException("nativeCompute returned null")
          val success = raw["success"] as? Boolean ?: false
          if (!success) {
            val err = raw["error"] as? String ?: "compute failed"
            throw IllegalStateException(err)
          }
          @Suppress("UNCHECKED_CAST")
          events = mapEvents(raw["events"] as? List<*>)
        } finally {
          NativeInstanceGate.endUse(gateKey)
        }

        val elapsedMs = (SystemClock.uptimeMillis() - t0).toDouble()
        Log.d(
          AudioTaggingErrorCodes.TAG,
          "tagOffline done instanceId=$instanceId eventCount=${events.size} elapsedMs=$elapsedMs",
        )

        val eventArray = Arguments.createArray()
        for (event in events) {
          val map = Arguments.createMap()
          map.putString("name", event["name"] as? String ?: "")
          map.putInt("index", (event["index"] as? Number)?.toInt() ?: 0)
          map.putDouble("prob", (event["prob"] as? Number)?.toDouble() ?: 0.0)
          eventArray.pushMap(map)
        }

        val result = Arguments.createMap()
        result.putArray("events", eventArray)
        result.putDouble("audioDuration", audioDuration)
        result.putDouble("elapsedMs", elapsedMs)
        result.putInt("topK", effectiveTopK)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(AudioTaggingErrorCodes.TAG, "OOM during audio tagging", e)
        promise.reject(
          AudioTaggingErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("audio-tagging"),
          e,
        )
      } catch (e: Exception) {
        Log.e(AudioTaggingErrorCodes.TAG, "Audio tagging failed", e)
        promise.reject(
          AudioTaggingErrorCodes.TAG_FAILED,
          "Audio tagging failed: ${e.message}",
          e,
        )
      }
    }
  }

  fun unloadAudioTagging(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.resolve(null)
      return
    }
    executor.execute {
      stopActiveLivePipeline(instanceId)
      val old = instances.remove(instanceId)
      if (old != null) {
        releaseTaggerSafely(old, where = "unload:$instanceId")
      } else {
        nativeUnload(instanceId)
      }
      promise.resolve(null)
    }
  }

  companion object {
    @JvmStatic
    private external fun nativeInitialize(
      instanceId: String,
      modelType: String,
      modelPath: String,
      labelsPath: String,
      topK: Int,
      numThreads: Int,
      provider: String,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeCompute(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
      topK: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeDefaultTopK(instanceId: String): Int

    @JvmStatic
    private external fun nativeHasInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnload(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }
}
