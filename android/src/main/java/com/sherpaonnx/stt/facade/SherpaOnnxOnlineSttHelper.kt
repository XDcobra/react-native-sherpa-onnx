package com.sherpaonnx.stt.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.stt.pipeline.SttPipelineWorker
import com.sherpaonnx.stt.core.OnlineSttRecognizerConfigFactory
import com.sherpaonnx.stt.core.SttErrorCodes
import com.sherpaonnx.stt.core.SttPathResolver
import com.sherpaonnx.text.pipeline.TextSegment
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Helper for streaming (online) STT using sherpa-onnx OnlineRecognizer + OnlineStream.
 * Manages recognizer instances and streams; resolves model paths by scanning the model directory.
 */
internal class SherpaOnnxOnlineSttHelper(
  private val context: ReactApplicationContext,
  private val logTag: String
) {

  private data class OnlineSttInstance(
    val recognizer: OnlineRecognizer,
    val config: OnlineRecognizerConfig,
    var activePipelineId: String? = null,
  )

  private val instances = ConcurrentHashMap<String, OnlineSttInstance>()

  private fun getInstance(instanceId: String): OnlineSttInstance? = instances[instanceId]

  private val pathResolver = SttPathResolver(context)
  private val configFactory = OnlineSttRecognizerConfigFactory(pathResolver)

  private fun emitLiveTextSegmentEvent(
    liveBufferId: String,
    segment: TextSegment,
    totalSegments: Int,
  ) {
    try {
      val payload = Arguments.createMap().apply {
        putString("liveBufferId", liveBufferId)
        putInt("totalSegments", totalSegments)
        putString("text", segment.text)
        putString("source", segment.source)
        putInt("segmentIndex", segment.segmentIndex)

        if (segment.tokens.isNotEmpty()) {
          val tokenArray = Arguments.createArray()
          segment.tokens.forEach { tokenArray.pushString(it) }
          putArray("tokens", tokenArray)
        }

        if (segment.timestamps.isNotEmpty()) {
          val tsArray = Arguments.createArray()
          segment.timestamps.forEach { tsArray.pushDouble(it.toDouble()) }
          putArray("timestamps", tsArray)
        }

        segment.meta?.let { rawMeta ->
          try {
            putMap("meta", Arguments.makeNativeMap(HashMap(rawMeta)))
          } catch (_: Exception) {
            // Ignore non-serializable meta values.
          }
        }
      }

      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("pipelineLiveTextSegment", payload)
    } catch (_: Exception) {
      // JS bridge might already be shutting down.
    }
  }

  fun initializeOnlineStt(
    instanceId: String,
    modelDir: String,
    modelType: String,
    enableEndpoint: Boolean,
    decodingMethod: String,
    maxActivePaths: Int,
    hotwordsFile: String?,
    hotwordsScore: Double?,
    numThreads: Double?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Double?,
    blankPenalty: Double?,
    debug: Boolean?,
    rule1MustContainNonSilence: Boolean?,
    rule1MinTrailingSilence: Double?,
    rule1MinUtteranceLength: Double?,
    rule2MustContainNonSilence: Boolean?,
    rule2MinTrailingSilence: Double?,
    rule2MinUtteranceLength: Double?,
    rule3MustContainNonSilence: Boolean?,
    rule3MinTrailingSilence: Double?,
    rule3MinUtteranceLength: Double?,
    promise: Promise
  ) {
    try {
      val config = configFactory.buildOnlineRecognizerConfig(
        modelDir = modelDir,
        modelType = modelType,
        enableEndpoint = enableEndpoint,
        decodingMethod = decodingMethod,
        maxActivePaths = maxActivePaths,
        hotwordsFile = hotwordsFile,
        hotwordsScore = hotwordsScore?.toFloat(),
        numThreads = numThreads?.toInt(),
        provider = provider,
        ruleFsts = ruleFsts,
        ruleFars = ruleFars,
        dither = dither?.toFloat(),
        blankPenalty = blankPenalty?.toFloat(),
        debug = debug,
        rule1MustContainNonSilence = rule1MustContainNonSilence,
        rule1MinTrailingSilence = rule1MinTrailingSilence?.toFloat(),
        rule1MinUtteranceLength = rule1MinUtteranceLength?.toFloat(),
        rule2MustContainNonSilence = rule2MustContainNonSilence,
        rule2MinTrailingSilence = rule2MinTrailingSilence?.toFloat(),
        rule2MinUtteranceLength = rule2MinUtteranceLength?.toFloat(),
        rule3MustContainNonSilence = rule3MustContainNonSilence,
        rule3MinTrailingSilence = rule3MinTrailingSilence?.toFloat(),
        rule3MinUtteranceLength = rule3MinUtteranceLength?.toFloat()
      )
      val recognizer = OnlineRecognizer(assetManager = null, config = config)
      instances[instanceId] = OnlineSttInstance(recognizer = recognizer, config = config)
      promise.resolve(Arguments.createMap().apply { putBoolean("success", true) })
    } catch (e: Exception) {
      Log.e(logTag, "initializeOnlineStt failed: ${e.message}", e)
      promise.reject(SttErrorCodes.INIT_FAILED, "Online STT init failed: ${e.message}", e)
    }
  }


  fun unloadOnlineStt(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId) ?: run {
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
      inst.recognizer.release()
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
      if (inst == null) {
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

      val recognizerSampleRate = inst.config.featConfig.sampleRate
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
      val stream = inst.recognizer.createStream()

      val worker = SttPipelineWorker(
        pipelineId = pipelineId,
        recognizer = inst.recognizer,
        stream = stream,
        inputEntry = inputEntry,
        outputEntry = outputEntry,
        chunkSize = chunkSize ?: 3200,
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
        inst.recognizer.release()
      } catch (e: Exception) {
        Log.w(logTag, "shutdown: failed to release instance $instanceId: ${e.message}")
      }
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
