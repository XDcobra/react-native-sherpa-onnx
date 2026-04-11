package com.sherpaonnx.tts.core

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.sherpaonnx.AlignmentTtsSinkSnapshot
import com.sherpaonnx.pcm.PcmPlayerService
import com.sherpaonnx.tts.service.TtsBatchGenerationService
import com.sherpaonnx.tts.service.TtsInitializationService
import com.sherpaonnx.tts.service.TtsLifecycleService
import com.sherpaonnx.tts.service.TtsStreamingService
import java.util.concurrent.Executors

/**
 * Thin coordinator: wires TTS services and preserves the public API previously on [SherpaOnnxTtsHelper].
 */
internal class SherpaOnnxTtsCoordinator(
  context: ReactApplicationContext,
  detectTtsModel: (modelDir: String, assetName: String?, modelType: String?) -> HashMap<String, Any>?,
  private val emitChunk: (String, String, FloatArray, Int, Float, Boolean) -> Unit,
  private val emitError: (String, String, String) -> Unit,
  private val emitEnd: (String, String, Boolean) -> Unit,
  private val emitFileError: (String, String, String, String?) -> Unit,
  private val emitFileEnd: (String, String, Boolean, String, Long, Int) -> Unit,
  private val pcmPlayerService: PcmPlayerService
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

  private val streamingService = TtsStreamingService(
    repository,
    emitChunk,
    emitError,
    emitEnd,
    emitFileError,
    emitFileEnd,
    pcmPlayerService
  )

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

  fun getBatchSinkSnapshot(instanceId: String, generation: Long): AlignmentTtsSinkSnapshot {
    val inst = repository[instanceId]
      ?: throw IllegalStateException("TTS instance not found: $instanceId")
    synchronized(inst.sinkLock) {
      val currentGen = inst.sink.generation.get()
      if (currentGen == 0L || inst.sink.samples == null) {
        throw IllegalStateException("No batch synthesis result available for instance $instanceId")
      }
      if (generation != currentGen) {
        throw IllegalStateException(ttsStaleGenerationUserMessage(generation, currentGen))
      }
      val samples = inst.sink.samples?.copyOf()
        ?: throw IllegalStateException("No sink samples available for instance $instanceId")
      return AlignmentTtsSinkSnapshot(
        samples = samples,
        sampleRate = inst.sink.sampleRate,
        numSamples = inst.sink.numSamples,
      )
    }
  }

  fun generateTtsStreamToFile(
    instanceId: String,
    requestId: String,
    text: String,
    options: ReadableMap?,
    fileOptions: ReadableMap?,
    promise: Promise
  ) = streamingService.generateTtsStreamToFile(instanceId, requestId, text, options, fileOptions, promise)

  fun generateTtsStream(instanceId: String, requestId: String, text: String, options: ReadableMap?, promise: Promise) =
    streamingService.generateTtsStream(instanceId, requestId, text, options, promise)

  fun cancelTtsStream(instanceId: String, promise: Promise) =
    streamingService.cancelTtsStream(instanceId, promise)

  fun getTtsSampleRate(instanceId: String, promise: Promise) =
    lifecycleService.getTtsSampleRate(instanceId, promise)

  fun getTtsNumSpeakers(instanceId: String, promise: Promise) =
    lifecycleService.getTtsNumSpeakers(instanceId, promise)

  fun unloadTts(instanceId: String, promise: Promise) =
    lifecycleService.unloadTts(instanceId, promise)

  fun detectTtsModel(modelDir: String, assetName: String?, modelType: String?, promise: Promise) =
    lifecycleService.detectTtsModel(modelDir, assetName, modelType, promise)
}
