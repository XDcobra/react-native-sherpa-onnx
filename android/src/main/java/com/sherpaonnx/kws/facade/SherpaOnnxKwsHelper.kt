package com.sherpaonnx.kws.facade

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.kws.pipeline.KwsStreamingPipelineWorker
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxKwsHelper(
  private val context: ReactApplicationContext,
) {
  private data class KwsInstance(
    val spotter: KeywordSpotter,
    val sampleRate: Int,
    var activePipelineId: String? = null,
  )

  private val instances = ConcurrentHashMap<String, KwsInstance>()
  private val mainHandler = Handler(Looper.getMainLooper())

  fun initializeKeywordSpotting(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(ERROR_INIT, "instanceId is required")
      return
    }

    val paths = listOf("encoder", "decoder", "joiner", "tokens", "keywords")
      .associateWith { key ->
        if (options.hasKey(key) && !options.isNull(key)) {
          options.getString(key)?.trim().orEmpty()
        } else {
          ""
        }
      }
    val missing = paths.filterValues { it.isEmpty() }.keys
    if (missing.isNotEmpty()) {
      promise.reject(ERROR_INIT, "Missing required KWS paths: ${missing.joinToString(", ")}")
      return
    }

    if (instances.containsKey(instanceId)) {
      promise.reject(ERROR_INIT, "Keyword spotting instance already exists: $instanceId")
      return
    }

    try {
      val sampleRate = 16000
      val modelConfig = OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = paths.getValue("encoder"),
          decoder = paths.getValue("decoder"),
          joiner = paths.getValue("joiner"),
        ),
        tokens = paths.getValue("tokens"),
        numThreads = optionInt(options, "numThreads", 1).coerceAtLeast(1),
        debug = optionBoolean(options, "debug", false),
        provider = optionString(options, "provider", "cpu"),
        modelType = "zipformer2",
      )
      val config = KeywordSpotterConfig(
        featConfig = FeatureConfig(sampleRate = sampleRate, featureDim = 80),
        modelConfig = modelConfig,
        maxActivePaths = optionInt(options, "maxActivePaths", 4),
        keywordsFile = paths.getValue("keywords"),
        keywordsScore = optionFloat(options, "keywordsScore", 1.5f),
        keywordsThreshold = optionFloat(options, "keywordsThreshold", 0.25f),
        numTrailingBlanks = optionInt(options, "numTrailingBlanks", 2),
      )
      val spotter = KeywordSpotter(assetManager = null, config = config)
      val inst = KwsInstance(spotter = spotter, sampleRate = sampleRate)
      val existing = instances.putIfAbsent(instanceId, inst)
      if (existing != null) {
        spotter.release()
        promise.reject(ERROR_INIT, "Keyword spotting instance already exists: $instanceId")
        return
      }

      Log.i(TAG, "$PREFIX initialized instanceId=$instanceId")
      promise.resolve(Arguments.createMap().apply { putBoolean("success", true) })
    } catch (e: Exception) {
      Log.e(TAG, "$PREFIX initialize failed instanceId=$instanceId: ${e.message}", e)
      promise.reject(ERROR_INIT, "Keyword spotting init failed: ${e.message}", e)
    }
  }

  fun startKeywordSpottingPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    chunkSize: Int?,
    keywords: String?,
    promise: Promise,
  ) {
    try {
      val inst = instances[instanceId]
      if (inst == null) {
        promise.reject(
          "KWS_PIPELINE_INSTANCE_NOT_FOUND",
          "Keyword spotting instance not found: $instanceId",
        )
        return
      }

      val inputEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (inputEntry == null) {
        promise.reject(
          "KWS_PIPELINE_AUDIO_BUFFER_NOT_FOUND",
          "Input live audio buffer not found: $audioInLiveBufferId",
        )
        return
      }

      val outputEntry = TextPipelineRegistry.getLive(textOutLiveBufferId)
      if (outputEntry == null) {
        promise.reject(
          "KWS_PIPELINE_TEXT_BUFFER_NOT_FOUND",
          "Output live text buffer not found: $textOutLiveBufferId",
        )
        return
      }

      if (inputEntry.kind != "livePcmBuffer") {
        promise.reject("KWS_PIPELINE_BUFFER_KIND_MISMATCH", "Input buffer must be a live audio buffer")
        return
      }

      if (inputEntry.state != LiveEntry.State.RECORDING) {
        promise.reject("KWS_PIPELINE_BUFFER_NOT_RECORDING", "Input audio buffer is not in recording state")
        return
      }

      if (outputEntry.state != com.sherpaonnx.text.pipeline.LiveTextEntry.State.RECORDING) {
        promise.reject("KWS_PIPELINE_BUFFER_NOT_RECORDING", "Output text buffer is not in recording state")
        return
      }

      if (inputEntry.sampleRate != inst.sampleRate) {
        promise.reject(
          "KWS_PIPELINE_SAMPLE_RATE_MISMATCH",
          "Input buffer sample rate (${inputEntry.sampleRate}) does not match spotter sample rate (${inst.sampleRate})",
        )
        return
      }

      synchronized(inst) {
        val existingPipelineId = inst.activePipelineId
        if (!existingPipelineId.isNullOrBlank()) {
          val existingWorker = StreamingPipelineRegistry.get(existingPipelineId)
          if (existingWorker != null && existingWorker.isRunning) {
            promise.reject(
              "KWS_PIPELINE_ALREADY_RUNNING",
              "Keyword spotting pipeline already running for instance: $instanceId",
            )
            return
          }
          StreamingPipelineRegistry.remove(existingPipelineId)
          inst.activePipelineId = null
        }
      }

      val pipelineId = UUID.randomUUID().toString()
      val keywordsOverride = keywords?.trim().orEmpty()
      val stream = inst.spotter.createStream(keywordsOverride)

      val worker = KwsStreamingPipelineWorker(
        pipelineId = pipelineId,
        spotter = inst.spotter,
        stream = stream,
        inputEntry = inputEntry,
        outputEntry = outputEntry,
        sampleRate = inst.sampleRate,
        chunkSize = chunkSize ?: KwsStreamingPipelineWorker.DEFAULT_CHUNK_SIZE,
      )

      StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
        synchronized(inst) {
          if (inst.activePipelineId == pipelineId) {
            inst.activePipelineId = null
          }
        }
      }

      synchronized(inst) {
        inst.activePipelineId = pipelineId
      }

      Log.i(
        TAG,
        "$PREFIX pipeline start instanceId=$instanceId pipelineId=$pipelineId " +
          "keywordsOverride=${keywordsOverride.isNotEmpty()}",
      )
      promise.resolve(
        Arguments.createMap().apply { putString("pipelineId", pipelineId) },
      )
    } catch (e: Exception) {
      Log.e(TAG, "$PREFIX startKeywordSpottingPipeline failed: ${e.message}", e)
      promise.reject(
        "STREAMING_PIPELINE_ERROR",
        "Failed to start keyword spotting pipeline: ${e.message}",
        e,
      )
    }
  }

  fun unloadKeywordSpotting(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId)
      if (inst != null) {
        synchronized(inst) {
          val activePipelineId = inst.activePipelineId
          if (!activePipelineId.isNullOrBlank()) {
            StreamingPipelineRegistry.stop(activePipelineId)
            StreamingPipelineRegistry.remove(activePipelineId)
          }
          inst.activePipelineId = null
        }
        inst.spotter.release()
      }
      Log.i(TAG, "$PREFIX unloaded instanceId=$instanceId found=${inst != null}")
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "$PREFIX unload failed instanceId=$instanceId: ${e.message}", e)
      promise.reject(ERROR_INTERNAL, "Keyword spotting unload failed: ${e.message}", e)
    }
  }

  fun shutdown() {
    instances.keys.toList().forEach { instanceId ->
      try {
        val inst = instances.remove(instanceId) ?: return@forEach
        synchronized(inst) {
          val activePipelineId = inst.activePipelineId
          if (!activePipelineId.isNullOrBlank()) {
            StreamingPipelineRegistry.stop(activePipelineId)
            StreamingPipelineRegistry.remove(activePipelineId)
          }
          inst.activePipelineId = null
        }
        inst.spotter.release()
      } catch (e: Exception) {
        Log.w(TAG, "$PREFIX shutdown release failed instanceId=$instanceId: ${e.message}")
      }
    }
  }

  private fun emitPipelineCompletedEvent(completion: StreamingPipelineCompletion) {
    // Match iOS completion watcher: deliver RN events on the main looper.
    val emit = Runnable {
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
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      emit.run()
    } else {
      mainHandler.post(emit)
    }
  }

  private fun optionString(options: ReadableMap, key: String, fallback: String): String =
    if (options.hasKey(key) && !options.isNull(key)) {
      options.getString(key)?.trim().orEmpty().ifEmpty { fallback }
    } else {
      fallback
    }

  private fun optionInt(options: ReadableMap, key: String, fallback: Int): Int =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key).toInt() else fallback

  private fun optionFloat(options: ReadableMap, key: String, fallback: Float): Float =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key).toFloat() else fallback

  private fun optionBoolean(options: ReadableMap, key: String, fallback: Boolean): Boolean =
    if (options.hasKey(key) && !options.isNull(key)) options.getBoolean(key) else fallback

  companion object {
    private const val TAG = "SherpaOnnxKws"
    private const val PREFIX = "[SherpaOnnx:kws]"
    private const val ERROR_INIT = "KWS_INIT_FAILED"
    private const val ERROR_INTERNAL = "KWS_INTERNAL_ERROR"
  }
}
