package com.sherpaonnx.audiotagging.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.AudioTagging
import com.k2fsa.sherpa.onnx.OfflineStream
import com.sherpaonnx.audiotagging.config.AudioTaggingInitOptionsParser
import com.sherpaonnx.audiotagging.core.AudioTaggingErrorCodes
import com.sherpaonnx.audiotagging.core.AudioTaggingModelConfigFactory
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.errors.OfflineOomError
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
  private data class Instance(
    val tagger: AudioTagging,
    val defaultTopK: Int,
  )

  private sealed class ResolveResult {
    data class Ok(val modelType: String, val paths: Map<String, String>) : ResolveResult()
    data class Err(val code: String, val message: String) : ResolveResult()
  }

  private val executor = Executors.newSingleThreadExecutor()
  private val instances = ConcurrentHashMap<String, Instance>()

  fun shutdown() {
    executor.shutdownNow()
    for ((_, instance) in instances) {
      releaseTaggerSafely(instance.tagger, where = "shutdown")
    }
    instances.clear()
  }

  private fun releaseTaggerSafely(tagger: AudioTagging, where: String) {
    val gateKey = NativeInstanceGate.keyFor(tagger)
    val identity = System.identityHashCode(tagger)
    val inFlight = NativeInstanceGate.inFlight(gateKey)
    if (inFlight > 0) {
      Log.w(
        AudioTaggingErrorCodes.TAG,
        "UNLOAD_DURING_COMPUTE where=$where tagger=$identity gateKey=$gateKey inFlight=$inFlight",
      )
    }
    val released = NativeInstanceGate.releaseWhenIdle(gateKey) {
      try {
        tagger.release()
      } catch (e: Exception) {
        Log.w(
          AudioTaggingErrorCodes.TAG,
          "unload.releaseError where=$where tagger=$identity msg=${e.message}",
        )
      }
    }
    Log.d(
      AudioTaggingErrorCodes.TAG,
      "unload.releaseWhenIdle where=$where tagger=$identity nativeReleased=$released inFlightWas=$inFlight",
    )
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
              releaseTaggerSafely(old.tagger, where = "reinit:$instanceId")
            }

            Log.d(
              AudioTaggingErrorCodes.TAG,
              "init branch=${parsed.initMode} instanceId=$instanceId modelType=${resolved.modelType} " +
                "topK=${parsed.topK} model=${resolved.paths["model"]} labels=${resolved.paths["labels"]}",
            )

            val config = AudioTaggingModelConfigFactory.build(
              modelType = resolved.modelType,
              paths = resolved.paths,
              topK = parsed.topK,
              numThreads = parsed.numThreads,
              provider = parsed.provider,
              debug = parsed.debug,
            )
            val tagger = AudioTagging(config = config)
            instances[instanceId] = Instance(tagger = tagger, defaultTopK = parsed.topK)

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
    promise: Promise,
  ) {
    val instance = instances[instanceId]
    if (instance == null) {
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

    val effectiveTopK = (topK?.toInt() ?: instance.defaultTopK).coerceAtLeast(1)

    executor.execute {
      var stream: OfflineStream? = null
      try {
        val t0 = SystemClock.uptimeMillis()
        val sampleRate = audioEntry.sampleRate
        val samples = audioEntry.readAllSamples()
        val audioDuration =
          if (sampleRate > 0) samples.size.toDouble() / sampleRate.toDouble() else 0.0

        Log.d(
          AudioTaggingErrorCodes.TAG,
          "tagOffline instanceId=$instanceId bufferId=$audioBufferId " +
            "sampleRate=$sampleRate numSamples=${samples.size} topK=$effectiveTopK",
        )

        val tagger = instance.tagger
        val gateKey = NativeInstanceGate.keyFor(tagger)
        if (!NativeInstanceGate.beginUse(gateKey)) {
          promise.reject(
            AudioTaggingErrorCodes.NOT_INITIALIZED,
            "Audio tagging instance released: $instanceId",
          )
          return@execute
        }

        val events = try {
          stream = tagger.createStream()
          stream.acceptWaveform(samples, sampleRate)
          tagger.compute(stream, effectiveTopK)
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
          map.putString("name", event.name)
          map.putInt("index", event.index)
          map.putDouble("prob", event.prob.toDouble())
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
      } finally {
        try {
          stream?.release()
        } catch (_: Exception) {
        }
      }
    }
  }

  fun unloadAudioTagging(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.resolve(null)
      return
    }
    executor.execute {
      instances.remove(instanceId)?.let { old ->
        releaseTaggerSafely(old.tagger, where = "unload:$instanceId")
      }
      promise.resolve(null)
    }
  }
}
