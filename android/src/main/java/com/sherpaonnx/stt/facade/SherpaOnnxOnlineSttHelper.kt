package com.sherpaonnx.stt.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.stt.config.OnlineSttInitOptionsParser
import com.sherpaonnx.stt.pipeline.SttPipelineWorker
import com.sherpaonnx.stt.core.SttErrorCodes
import com.sherpaonnx.stt.core.SttPathResolver
import com.sherpaonnx.text.pipeline.TextSegment
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Helper for streaming (online) STT via shared CXX OnlineSttWrapper (JNI).
 * Manages recognizer instances and streams; auto mode scans the model directory in C++.
 */
internal class SherpaOnnxOnlineSttHelper(
  private val context: ReactApplicationContext,
  private val logTag: String
) {
  private data class OnlineSttInstance(
    val sampleRate: Int,
    var activePipelineId: String? = null,
  )

  private val instances = ConcurrentHashMap<String, OnlineSttInstance>()

  private fun getInstance(instanceId: String): OnlineSttInstance? = instances[instanceId]

  private val pathResolver = SttPathResolver(context)

  private fun emitLiveTextSegmentEvent(
    liveBufferId: String,
    segment: TextSegment,
    totalSegments: Int,
  ) {
    try {
      val payload = Arguments.createMap().apply {
        putString("liveBufferId", liveBufferId)
        putInt("totalSegments", totalSegments)
        putString("source", segment.source)
        putInt("segmentIndex", segment.segmentIndex)
        putInt("utf16Length", segment.text.length)
      }

      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("pipelineLiveTextSegmentAppended", payload)
    } catch (_: Exception) {
      // JS bridge might already be shutting down.
    }
  }

  private fun resolveOptionalPaths(parsed: OnlineSttInitOptionsParser.Parsed): Triple<String, String, String> {
    val resolvedRuleFsts = try {
      pathResolver.resolveFilePaths(parsed.ruleFsts.orEmpty().trim(), "online_stt_rule_fst")
    } catch (_: Exception) {
      ""
    }
    val resolvedRuleFars = try {
      pathResolver.resolveFilePaths(parsed.ruleFars.orEmpty().trim(), "online_stt_rule_far")
    } catch (_: Exception) {
      ""
    }
    var resolvedHotwordsFile = parsed.hotwordsFile?.trim().orEmpty()
    if (resolvedHotwordsFile.isNotEmpty()) {
      try {
        resolvedHotwordsFile =
          pathResolver.resolveContentUriToFile(resolvedHotwordsFile, "online_stt_hotwords")
      } catch (_: Exception) {
        resolvedHotwordsFile = ""
      }
    }
    return Triple(resolvedHotwordsFile, resolvedRuleFsts, resolvedRuleFars)
  }

  fun initializeOnlineStt(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) {
    val parsed = OnlineSttInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        SttErrorCodes.INIT_FAILED,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        }
      )
      return
    }

    val modelType = parsed.modelType?.trim().orEmpty().ifEmpty { "transducer" }
    val enableEndpoint = parsed.enableEndpoint ?: true
    val decodingMethod = parsed.decodingMethod?.trim().orEmpty().ifEmpty { "greedy_search" }
    val maxActivePaths = parsed.maxActivePaths ?: 4
    val (hotwordsFile, ruleFsts, ruleFars) = resolveOptionalPaths(parsed)

    try {
      @Suppress("UNCHECKED_CAST")
      val raw = if (parsed.initMode == "custom") {
        val pathStrings = parsed.modelPaths.orEmpty()
        ModelPathValidationNative.validate("stt_streaming", modelType, pathStrings)?.let { errorMsg ->
          Log.e(logTag, errorMsg)
          promise.reject(SttErrorCodes.INIT_FAILED, errorMsg)
          return
        }
        Log.i(logTag, "[SherpaOnnx:init] online-stt Create custom start")
        nativeInitializeCustom(
          instanceId = instanceId,
          modelType = modelType,
          paths = HashMap(pathStrings),
          enableEndpoint = enableEndpoint,
          decodingMethod = decodingMethod,
          maxActivePaths = maxActivePaths,
          hotwordsFile = hotwordsFile,
          hotwordsScore = parsed.hotwordsScore?.toFloat() ?: 1.5f,
          numThreads = parsed.numThreads?.toInt() ?: 1,
          provider = parsed.provider ?: "cpu",
          ruleFsts = ruleFsts,
          ruleFars = ruleFars,
          dither = parsed.dither?.toFloat() ?: 0f,
          blankPenalty = parsed.blankPenalty?.toFloat() ?: 0f,
          debug = parsed.debug ?: false,
          rule1MustContainNonSilence = parsed.rule1MustContainNonSilence ?: false,
          rule1MinTrailingSilence = parsed.rule1MinTrailingSilence?.toFloat() ?: 2.4f,
          rule1MinUtteranceLength = parsed.rule1MinUtteranceLength?.toFloat() ?: 0f,
          rule2MustContainNonSilence = parsed.rule2MustContainNonSilence ?: true,
          rule2MinTrailingSilence = parsed.rule2MinTrailingSilence?.toFloat() ?: 1.4f,
          rule2MinUtteranceLength = parsed.rule2MinUtteranceLength?.toFloat() ?: 0f,
          rule3MustContainNonSilence = parsed.rule3MustContainNonSilence ?: false,
          rule3MinTrailingSilence = parsed.rule3MinTrailingSilence?.toFloat() ?: 0f,
          rule3MinUtteranceLength = parsed.rule3MinUtteranceLength?.toFloat() ?: 20f,
        ) as? HashMap<String, Any>
      } else {
        Log.i(logTag, "[SherpaOnnx:init] online-stt Create auto start")
        nativeInitialize(
          instanceId = instanceId,
          modelDir = parsed.modelDir.orEmpty(),
          modelType = modelType,
          enableEndpoint = enableEndpoint,
          decodingMethod = decodingMethod,
          maxActivePaths = maxActivePaths,
          hotwordsFile = hotwordsFile,
          hotwordsScore = parsed.hotwordsScore?.toFloat() ?: 1.5f,
          numThreads = parsed.numThreads?.toInt() ?: 1,
          provider = parsed.provider ?: "cpu",
          ruleFsts = ruleFsts,
          ruleFars = ruleFars,
          dither = parsed.dither?.toFloat() ?: 0f,
          blankPenalty = parsed.blankPenalty?.toFloat() ?: 0f,
          debug = parsed.debug ?: false,
          rule1MustContainNonSilence = parsed.rule1MustContainNonSilence ?: false,
          rule1MinTrailingSilence = parsed.rule1MinTrailingSilence?.toFloat() ?: 2.4f,
          rule1MinUtteranceLength = parsed.rule1MinUtteranceLength?.toFloat() ?: 0f,
          rule2MustContainNonSilence = parsed.rule2MustContainNonSilence ?: true,
          rule2MinTrailingSilence = parsed.rule2MinTrailingSilence?.toFloat() ?: 1.4f,
          rule2MinUtteranceLength = parsed.rule2MinUtteranceLength?.toFloat() ?: 0f,
          rule3MustContainNonSilence = parsed.rule3MustContainNonSilence ?: false,
          rule3MinTrailingSilence = parsed.rule3MinTrailingSilence?.toFloat() ?: 0f,
          rule3MinUtteranceLength = parsed.rule3MinUtteranceLength?.toFloat() ?: 20f,
        ) as? HashMap<String, Any>
      }

      val ok = raw?.get("success") as? Boolean ?: false
      if (!ok) {
        val err = raw?.get("error") as? String ?: "Online STT init failed"
        Log.e(logTag, "[SherpaOnnx:init] online-stt Create branch=reject $err")
        promise.reject(SttErrorCodes.INIT_FAILED, "Online STT init failed: $err")
        return
      }

      val sampleRate = nativeGetSampleRate(instanceId)
      Log.i(logTag, "[SherpaOnnx:init] online-stt Create ok sampleRate=$sampleRate")
      instances[instanceId] = OnlineSttInstance(sampleRate = sampleRate)
      promise.resolve(Arguments.createMap().apply { putBoolean("success", true) })
    } catch (e: Exception) {
      Log.e(logTag, "[SherpaOnnx:init] online-stt Create branch=reject ${e.message}", e)
      promise.reject(SttErrorCodes.INIT_FAILED, "Online STT init failed: ${e.message}", e)
    }
  }

  fun unloadOnlineStt(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId) ?: run {
        nativeUnload(instanceId)
        promise.resolve(null)
        return
      }

      synchronized(inst) {
        val activePipelineId = inst.activePipelineId
        if (!activePipelineId.isNullOrBlank()) {
          StreamingPipelineRegistry.stop(activePipelineId)
          StreamingPipelineRegistry.remove(activePipelineId)
        }
        inst.activePipelineId = null
      }
      nativeUnload(instanceId)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "unloadOnlineStt failed: ${e.message}", e)
      promise.reject(SttErrorCodes.INTERNAL_ERROR, "unloadOnlineStt failed: ${e.message}", e)
    }
  }

  fun startSttPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    chunkSize: Int?,
    promise: Promise
  ) {
    try {
      val inst = getInstance(instanceId)
      if (inst == null || !nativeHasInstance(instanceId)) {
        promise.reject("STT_PIPELINE_INSTANCE_NOT_FOUND", "Online STT instance not found: $instanceId")
        return
      }

      val inputEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (inputEntry == null) {
        promise.reject("STT_PIPELINE_AUDIO_BUFFER_NOT_FOUND", "Input live audio buffer not found: $audioInLiveBufferId")
        return
      }

      val outputEntry = TextPipelineRegistry.getLive(textOutLiveBufferId)
      if (outputEntry == null) {
        promise.reject("STT_PIPELINE_TEXT_BUFFER_NOT_FOUND", "Output live text buffer not found: $textOutLiveBufferId")
        return
      }

      if (inputEntry.kind != "livePcmBuffer") {
        promise.reject("STT_PIPELINE_BUFFER_KIND_MISMATCH", "Input buffer must be a live audio buffer")
        return
      }

      if (inputEntry.state != LiveEntry.State.RECORDING) {
        promise.reject("STT_PIPELINE_BUFFER_NOT_RECORDING", "Input audio buffer is not in recording state")
        return
      }

      if (outputEntry.state != com.sherpaonnx.text.pipeline.LiveTextEntry.State.RECORDING) {
        promise.reject("STT_PIPELINE_BUFFER_NOT_RECORDING", "Output text buffer is not in recording state")
        return
      }

      val recognizerSampleRate = inst.sampleRate
      if (inputEntry.sampleRate != recognizerSampleRate) {
        promise.reject(
          "STT_PIPELINE_SAMPLE_RATE_MISMATCH",
          "Input buffer sample rate (${inputEntry.sampleRate}) does not match recognizer sample rate ($recognizerSampleRate)"
        )
        return
      }

      synchronized(inst) {
        val existingPipelineId = inst.activePipelineId
        if (!existingPipelineId.isNullOrBlank()) {
          val existingWorker = StreamingPipelineRegistry.get(existingPipelineId)
          if (existingWorker != null && existingWorker.isRunning) {
            promise.reject("STT_PIPELINE_ALREADY_RUNNING", "STT pipeline already running for instance: $instanceId")
            return
          }
          StreamingPipelineRegistry.remove(existingPipelineId)
          inst.activePipelineId = null
        }
      }

      val pipelineId = UUID.randomUUID().toString()
      val streamId = pipelineId
      if (!nativeCreateStream(instanceId, streamId, "")) {
        promise.reject("STREAMING_PIPELINE_ERROR", "Failed to create online STT stream")
        return
      }

      val worker = SttPipelineWorker(
        pipelineId = pipelineId,
        instanceId = instanceId,
        streamId = streamId,
        sampleRate = recognizerSampleRate,
        inputEntry = inputEntry,
        outputEntry = outputEntry,
        chunkSize = chunkSize ?: 6400,
        onSegmentCommitted = { segment, totalSegments ->
          emitLiveTextSegmentEvent(textOutLiveBufferId, segment, totalSegments)
        },
      )

      StreamingPipelineRegistry.registerAndStart(worker) {
        completion -> emitPipelineCompletedEvent(completion)
      }

      synchronized(inst) {
        inst.activePipelineId = pipelineId
      }

      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(logTag, "startSttPipeline failed: ${e.message}", e)
      promise.reject("STREAMING_PIPELINE_ERROR", "Failed to start STT pipeline: ${e.message}", e)
    }
  }

  /** Call from Module.onCatalystInstanceDestroy to release all resources. */
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
        nativeUnload(instanceId)
      } catch (e: Exception) {
        Log.w(logTag, "shutdown: failed to release instance $instanceId: ${e.message}")
      }
    }
    nativeShutdownAll()
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
    @JvmStatic
    private external fun nativeInitialize(
      instanceId: String,
      modelDir: String,
      modelType: String,
      enableEndpoint: Boolean,
      decodingMethod: String,
      maxActivePaths: Int,
      hotwordsFile: String,
      hotwordsScore: Float,
      numThreads: Int,
      provider: String,
      ruleFsts: String,
      ruleFars: String,
      dither: Float,
      blankPenalty: Float,
      debug: Boolean,
      rule1MustContainNonSilence: Boolean,
      rule1MinTrailingSilence: Float,
      rule1MinUtteranceLength: Float,
      rule2MustContainNonSilence: Boolean,
      rule2MinTrailingSilence: Float,
      rule2MinUtteranceLength: Float,
      rule3MustContainNonSilence: Boolean,
      rule3MinTrailingSilence: Float,
      rule3MinUtteranceLength: Float,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeInitializeCustom(
      instanceId: String,
      modelType: String,
      paths: HashMap<String, String>,
      enableEndpoint: Boolean,
      decodingMethod: String,
      maxActivePaths: Int,
      hotwordsFile: String,
      hotwordsScore: Float,
      numThreads: Int,
      provider: String,
      ruleFsts: String,
      ruleFars: String,
      dither: Float,
      blankPenalty: Float,
      debug: Boolean,
      rule1MustContainNonSilence: Boolean,
      rule1MinTrailingSilence: Float,
      rule1MinUtteranceLength: Float,
      rule2MustContainNonSilence: Boolean,
      rule2MinTrailingSilence: Float,
      rule2MinUtteranceLength: Float,
      rule3MustContainNonSilence: Boolean,
      rule3MinTrailingSilence: Float,
      rule3MinUtteranceLength: Float,
    ): HashMap<String, Any>?

    @JvmStatic
    internal external fun nativeCreateStream(
      instanceId: String,
      streamId: String,
      hotwords: String,
    ): Boolean

    @JvmStatic
    internal external fun nativeAcceptWaveform(
      instanceId: String,
      streamId: String,
      sampleRate: Int,
      samples: FloatArray,
    )

    @JvmStatic
    internal external fun nativeInputFinished(instanceId: String, streamId: String)

    @JvmStatic
    internal external fun nativeIsReady(instanceId: String, streamId: String): Boolean

    @JvmStatic
    internal external fun nativeDecode(instanceId: String, streamId: String)

    @JvmStatic
    internal external fun nativeGetResult(
      instanceId: String,
      streamId: String,
    ): HashMap<String, Any>?

    @JvmStatic
    internal external fun nativeIsEndpoint(instanceId: String, streamId: String): Boolean

    @JvmStatic
    internal external fun nativeResetStream(instanceId: String, streamId: String)

    @JvmStatic
    internal external fun nativeReleaseStream(instanceId: String, streamId: String)

    @JvmStatic
    private external fun nativeGetSampleRate(instanceId: String): Int

    @JvmStatic
    private external fun nativeHasInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnload(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }
}
