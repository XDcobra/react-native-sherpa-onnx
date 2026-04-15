package com.sherpaonnx.tts.core

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import com.sherpaonnx.tts.pipeline.TtsPipelineWorker
import com.sherpaonnx.tts.pipeline.TtsVoiceCloneConfig
import com.sherpaonnx.tts.service.TtsBatchGenerationService
import com.sherpaonnx.tts.service.TtsInitializationService
import com.sherpaonnx.tts.service.TtsLifecycleService
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Thin coordinator that wires TTS services behind module-facing facades. */
internal class SherpaOnnxTtsCoordinator(
  context: ReactApplicationContext,
  detectTtsModel: (modelDir: String, assetName: String?, modelType: String?) -> HashMap<String, Any>?,
) {
  private val repository = TtsEngineRepository()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val ttsInitExecutor = Executors.newSingleThreadExecutor()

  private val initializationService = TtsInitializationService(
    context,
    repository,
    detectTtsModel,
    mainHandler,
    ttsInitExecutor
  )

  private val batchGenerationService = TtsBatchGenerationService(repository)

  private val lifecycleService = TtsLifecycleService(
    repository,
    ttsInitExecutor,
    detectTtsModel
  )

  fun shutdown() = lifecycleService.shutdown()

  fun initializeTts(
    instanceId: String,
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Double?,
    silenceScale: Double?,
    provider: String?,
    promise: Promise
  ) = initializationService.initializeTts(
    instanceId,
    modelDir,
    modelType,
    numThreads,
    debug,
    noiseScale,
    noiseScaleW,
    lengthScale,
    ruleFsts,
    ruleFars,
    maxNumSentences,
    silenceScale,
    provider,
    promise
  )

  fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) = initializationService.updateTtsParams(instanceId, noiseScale, noiseScaleW, lengthScale, promise)

  fun synthesizeTts(instanceId: String, textInBufferId: String, audioOutBufferId: String, options: ReadableMap?, promise: Promise) =
    batchGenerationService.synthesizeTts(instanceId, textInBufferId, audioOutBufferId, options, promise)

  fun getTtsSampleRate(instanceId: String, promise: Promise) =
    lifecycleService.getTtsSampleRate(instanceId, promise)

  fun getTtsNumSpeakers(instanceId: String, promise: Promise) =
    lifecycleService.getTtsNumSpeakers(instanceId, promise)

  fun unloadTts(instanceId: String, promise: Promise) =
    lifecycleService.unloadTts(instanceId, promise)

  fun detectTtsModel(modelDir: String, assetName: String?, modelType: String?, promise: Promise) =
    lifecycleService.detectTtsModel(modelDir, assetName, modelType, promise)

  // Instance → active pipeline tracking (one pipeline per engine instance)
  private val instanceToPipeline = ConcurrentHashMap<String, String>()

  fun startTtsPipeline(
    instanceId: String,
    textInLiveBufferId: String,
    audioOutLiveBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) {
    try {
      val inst = repository.get(instanceId)
      if (inst == null || !inst.hasEngine()) {
        promise.reject("TTS_PIPELINE_INSTANCE_NOT_FOUND", "TTS engine instance not found: $instanceId")
        return
      }

      val inputEntry = TextPipelineRegistry.getLive(textInLiveBufferId)
      if (inputEntry == null) {
        promise.reject("TTS_PIPELINE_TEXT_BUFFER_NOT_FOUND", "Input live text buffer not found: $textInLiveBufferId")
        return
      }

      val outputEntry = PipelineAudioRegistry.getLive(audioOutLiveBufferId)
      if (outputEntry == null) {
        promise.reject("TTS_PIPELINE_AUDIO_BUFFER_NOT_FOUND", "Output live audio buffer not found: $audioOutLiveBufferId")
        return
      }

      if (inputEntry.state != LiveTextEntry.State.RECORDING) {
        promise.reject("TTS_PIPELINE_BUFFER_NOT_RECORDING", "Input text buffer is not in recording state")
        return
      }

      if (outputEntry.state != LiveEntry.State.RECORDING) {
        promise.reject("TTS_PIPELINE_BUFFER_NOT_RECORDING", "Output audio buffer is not in recording state")
        return
      }

      val ttsSampleRate = inst.dispatchSampleRate()
      if (outputEntry.sampleRate != ttsSampleRate) {
        promise.reject(
          "TTS_PIPELINE_SAMPLE_RATE_MISMATCH",
          "Output buffer sample rate (${outputEntry.sampleRate}) does not match TTS model sample rate ($ttsSampleRate)"
        )
        return
      }

      // Check for existing pipeline
      val existingPipelineId = instanceToPipeline[instanceId]
      if (existingPipelineId != null) {
        val existingWorker = StreamingPipelineRegistry.get(existingPipelineId)
        if (existingWorker != null && existingWorker.isRunning) {
          promise.reject("TTS_PIPELINE_ALREADY_RUNNING", "TTS pipeline already running for instance: $instanceId")
          return
        }
        StreamingPipelineRegistry.remove(existingPipelineId)
        instanceToPipeline.remove(instanceId)
      }

      // Parse options
      val defaultSid = if (options?.hasKey("sid") == true) options.getDouble("sid").toInt() else 0
      val defaultSpeed = if (options?.hasKey("speed") == true) options.getDouble("speed").toFloat() else 1.0f

      // Resolve voice cloning
      var voiceCloneConfig: TtsVoiceCloneConfig? = null
      if (options?.hasKey("referenceAudioBufferId") == true) {
        val refBufferId = options.getString("referenceAudioBufferId")
        if (!refBufferId.isNullOrEmpty()) {
          val refEntry = PipelineAudioRegistry.getOffline(refBufferId)
          if (refEntry == null) {
            promise.reject("TTS_PIPELINE_VOICE_CLONE_REF_NOT_FOUND", "Reference audio buffer not found: $refBufferId")
            return
          }
          if (!inst.isPocket) {
            promise.reject("TTS_PIPELINE_VOICE_CLONE_UNSUPPORTED", "Voice cloning in pipeline mode is only supported for Pocket TTS")
            return
          }
          val refSamples = refEntry.readAllSamples()
          val refSampleRate = refEntry.sampleRate
          val referenceText = options.getString("referenceText") ?: ""
          val silenceScale = if (options.hasKey("silenceScale")) options.getDouble("silenceScale").toFloat() else 0.2f
          val numSteps = if (options.hasKey("numSteps")) options.getDouble("numSteps").toInt() else 5
          voiceCloneConfig = TtsVoiceCloneConfig(
            referenceAudio = refSamples,
            referenceSampleRate = refSampleRate,
            referenceText = referenceText,
            silenceScale = silenceScale,
            numSteps = numSteps,
          )
        }
      }

      val pipelineId = UUID.randomUUID().toString()
      val worker = TtsPipelineWorker(
        pipelineId = pipelineId,
        ttsInstance = inst,
        inputEntry = inputEntry,
        outputEntry = outputEntry,
        defaultSid = defaultSid,
        defaultSpeed = defaultSpeed,
        voiceClone = voiceCloneConfig,
      )

      StreamingPipelineRegistry.registerAndStart(worker)
      instanceToPipeline[instanceId] = pipelineId

      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("STREAMING_PIPELINE_ERROR", "Failed to start TTS pipeline: ${e.message}", e)
    }
  }
}
