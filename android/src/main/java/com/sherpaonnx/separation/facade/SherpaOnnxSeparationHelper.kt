package com.sherpaonnx.separation.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.separation.config.SeparationInitOptionsParser
import com.sherpaonnx.separation.core.SeparationErrorCodes

internal class SherpaOnnxSeparationHelper(
  private val nativeDetectSeparationModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?,
) {
  fun shutdown() {
    // Native instances are released per instanceId via unloadSeparation.
  }

  fun detectSeparationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise,
  ) {
    try {
      val result = nativeDetectSeparationModel(
        modelDir.ifBlank { null },
        assetName,
        modelType ?: "auto",
      )
      if (result == null) {
        promise.reject(
          SeparationErrorCodes.DETECT_ERROR,
          "Separation model detection returned null",
        )
        return
      }
      promise.resolve(detectResultToWritable(result))
    } catch (e: Exception) {
      promise.reject(
        SeparationErrorCodes.DETECT_ERROR,
        "Separation model detection failed: ${e.message}",
        e,
      )
    }
  }

  fun initializeSeparation(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(SeparationErrorCodes.SEPARATION_INIT_ERROR, "instanceId is required")
      return
    }
    val parsed = SeparationInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_INIT_ERROR,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        },
      )
      return
    }
    try {
      val numThreads = parsed.numThreads.toInt().coerceAtLeast(1)
      val result = if (parsed.initMode == "custom") {
        val modelTypeStr = parsed.modelType.trim()
        if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
          promise.reject(
            SeparationErrorCodes.SEPARATION_INIT_ERROR,
            "modelType is required for initMode custom",
          )
          return
        }
        val paths = parsed.modelPaths
        if (paths.isNullOrEmpty()) {
          promise.reject(
            SeparationErrorCodes.SEPARATION_INIT_ERROR,
            "modelPaths is required for initMode custom",
          )
          return
        }
        nativeInitializeSeparationCustom(
          instanceId,
          modelTypeStr,
          pathsToHashMap(paths),
          numThreads,
          parsed.provider,
          parsed.debug,
        )
      } else {
        val modelDir = parsed.modelDir
        if (modelDir.isNullOrBlank()) {
          promise.reject(
            SeparationErrorCodes.SEPARATION_INIT_ERROR,
            "modelDir is required for initMode auto",
          )
          return
        }
        nativeInitializeSeparationAuto(
          instanceId,
          modelDir,
          parsed.modelType,
          numThreads,
          parsed.provider,
          parsed.debug,
        )
      }
      if (result == null) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_INIT_ERROR,
          "Separation initialization returned null",
        )
        return
      }
      val success = result["success"] as? Boolean ?: false
      if (!success) {
        val error = result["error"] as? String
        promise.reject(
          SeparationErrorCodes.SEPARATION_INIT_ERROR,
          error?.takeIf { it.isNotBlank() } ?: "Failed to initialize separation",
        )
        return
      }
      promise.resolve(initResultToWritable(result))
    } catch (e: Exception) {
      Log.e(SeparationErrorCodes.TAG, "Failed to initialize separation", e)
      promise.reject(
        SeparationErrorCodes.SEPARATION_INIT_ERROR,
        "Failed to initialize separation: ${e.message}",
        e,
      )
    }
  }

  fun separateOfflineAudioBuffers(
    instanceId: String,
    audioInBufferId: String,
    audioOutBufferIds: ReadableArray,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(SeparationErrorCodes.SEPARATION_ERROR, "instanceId is required")
      return
    }

    if (!audioInBufferId.startsWith("off_")) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) for audioIn, got: $audioInBufferId",
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioInBufferId)
    if (audioInEntry == null) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioInBufferId",
      )
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_BUFFER_EMPTY,
        "Input offline audio buffer is empty: $audioInBufferId",
      )
      return
    }

    val expectedStems = nativeGetSeparationNumStems(instanceId)
    if (expectedStems <= 0) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_ERROR,
        "Separation instance not found: $instanceId",
      )
      return
    }
    if (audioOutBufferIds.size() != expectedStems) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_STEM_COUNT_MISMATCH,
        "Expected $expectedStems output buffers, got ${audioOutBufferIds.size()}",
      )
      return
    }

    val outputEntries = ArrayList<OfflineEntry.InMemory>(expectedStems)
    for (i in 0 until audioOutBufferIds.size()) {
      val outId = audioOutBufferIds.getString(i)
      if (outId.isNullOrBlank()) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_BUFFER_NOT_FOUND,
          "Output buffer id missing at index $i",
        )
        return
      }
      if (!outId.startsWith("off_")) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_BUFFER_KIND_MISMATCH,
          "Expected offline audio buffer (off_*) for audioOut, got: $outId",
        )
        return
      }
      val audioOutEntry = PipelineAudioRegistry.getOffline(outId)
      if (audioOutEntry == null) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_BUFFER_NOT_FOUND,
          "Offline audio buffer not found: $outId",
        )
        return
      }
      if (audioOutEntry !is OfflineEntry.InMemory) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_OUTPUT_NOT_EMPTY,
          "Output buffer must be an in-memory offline buffer: $outId",
        )
        return
      }
      if (audioOutEntry.numSamples != 0) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_OUTPUT_NOT_EMPTY,
          "Output offline audio buffer must be empty: $outId",
        )
        return
      }
      outputEntries.add(audioOutEntry)
    }

    try {
      val inputSamples = audioInEntry.readAllSamples()
      val stems = nativeProcessSeparation(
        instanceId,
        inputSamples,
        audioInEntry.sampleRate,
      )
      if (stems == null || stems.size != expectedStems) {
        promise.reject(
          SeparationErrorCodes.SEPARATION_ERROR,
          "Failed to separate audio: native process returned invalid stems",
        )
        return
      }
      for (i in 0 until expectedStems) {
        val stemSamples = stems[i]
        val outId = audioOutBufferIds.getString(i) ?: continue
        val audioOutEntry = outputEntries[i]
        if (!audioOutEntry.tryAdoptSamples(stemSamples)) {
          promise.reject(
            SeparationErrorCodes.SEPARATION_OUTPUT_NOT_EMPTY,
            "Output buffer was populated concurrently: $outId",
          )
          return
        }
        PipelineAudioRegistry.upgradeToMmapIfNeeded(outId)
      }
      promise.resolve(null)
    } catch (e: OutOfMemoryError) {
      Log.e(SeparationErrorCodes.TAG, "OOM Separation offline failed", e)
      promise.reject(
        SeparationErrorCodes.OFFLINE_OOM,
        OfflineOomError.message("separation"),
        e,
      )
    } catch (e: Exception) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_ERROR,
        "Failed to separate audio: ${e.message}",
        e,
      )
    }
  }

  fun getSampleRate(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.reject(SeparationErrorCodes.SEPARATION_ERROR, "instanceId is required")
      return
    }
    val sampleRate = nativeGetSeparationSampleRate(instanceId)
    if (sampleRate <= 0) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_ERROR,
        "Separation instance not found: $instanceId",
      )
      return
    }
    promise.resolve(sampleRate)
  }

  fun getNumStems(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.reject(SeparationErrorCodes.SEPARATION_ERROR, "instanceId is required")
      return
    }
    val numStems = nativeGetSeparationNumStems(instanceId)
    if (numStems <= 0) {
      promise.reject(
        SeparationErrorCodes.SEPARATION_ERROR,
        "Separation instance not found: $instanceId",
      )
      return
    }
    promise.resolve(numStems)
  }

  fun unloadSeparation(instanceId: String, promise: Promise) {
    if (instanceId.isBlank()) {
      promise.reject(SeparationErrorCodes.SEPARATION_ERROR, "instanceId is required")
      return
    }
    nativeReleaseSeparation(instanceId)
    promise.resolve(null)
  }

  private fun pathsToHashMap(paths: Map<String, String>): HashMap<String, String> {
    val map = HashMap<String, String>(paths.size)
    for ((key, value) in paths) {
      map[key] = value
    }
    return map
  }

  private fun initResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
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

    val sampleRate = result["sampleRate"] as? Int
    if (sampleRate != null && sampleRate > 0) {
      map.putInt("sampleRate", sampleRate)
    }
    val numStems = result["numStems"] as? Int
    if (numStems != null && numStems > 0) {
      map.putInt("numStems", numStems)
    }
    return map
  }

  private fun detectResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
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
      val vocals = paths["vocals"] as? String
      if (!vocals.isNullOrBlank()) writablePaths.putString("vocals", vocals)
      val accompaniment = paths["accompaniment"] as? String
      if (!accompaniment.isNullOrBlank()) {
        writablePaths.putString("accompaniment", accompaniment)
      }
      val modelPath = paths["model"] as? String
      if (!modelPath.isNullOrBlank()) writablePaths.putString("model", modelPath)
      if (writablePaths.toHashMap().isNotEmpty()) {
        map.putMap("paths", writablePaths)
      }
    }

    return map
  }

  private companion object {
    @JvmStatic
    private external fun nativeInitializeSeparationAuto(
      instanceId: String,
      modelDir: String,
      modelType: String,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeInitializeSeparationCustom(
      instanceId: String,
      modelType: String,
      modelPaths: HashMap<String, String>,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeProcessSeparation(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): Array<FloatArray>?

    @JvmStatic
    private external fun nativeGetSeparationSampleRate(instanceId: String): Int

    @JvmStatic
    private external fun nativeGetSeparationNumStems(instanceId: String): Int

    @JvmStatic
    private external fun nativeReleaseSeparation(instanceId: String)
  }
}
