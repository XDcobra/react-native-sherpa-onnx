package com.sherpaonnx.tts.core

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.sherpaonnx.tts.service.TtsAudioExportService
import com.sherpaonnx.tts.service.TtsBatchGenerationService
import com.sherpaonnx.tts.service.TtsInitializationService
import com.sherpaonnx.tts.service.TtsLifecycleService
import com.sherpaonnx.tts.service.TtsPcmPlaybackService
import com.sherpaonnx.tts.service.TtsStreamingService
import java.util.concurrent.Executors

/**
 * Thin coordinator: wires TTS services and preserves the public API previously on [SherpaOnnxTtsHelper].
 */
internal class SherpaOnnxTtsCoordinator(
  context: ReactApplicationContext,
  detectTtsModel: (modelDir: String, modelType: String) -> HashMap<String, Any>?,
  nativeBatchTtsCatalogHints: (Array<String>) -> java.util.ArrayList<java.util.HashMap<String, Any>>,
  private val emitChunk: (String, String, FloatArray, Int, Float, Boolean) -> Unit,
  private val emitError: (String, String, String) -> Unit,
  private val emitEnd: (String, String, Boolean) -> Unit,
  private val emitFileError: (String, String, String, String?) -> Unit,
  private val emitFileEnd: (String, String, Boolean, String, Long, Int) -> Unit,
  /** FFmpeg: mono f32le raw file → encoded output path. Returns empty string on success. */
  encodeMonoFromRawFile: (rawPath: String, pcmSampleRate: Int, outputPath: String, format: String, outputSampleRateHz: Int) -> String
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
    emitFileEnd
  )

  private val pcmPlaybackService = TtsPcmPlaybackService(repository)

  private val lifecycleService = TtsLifecycleService(
    repository,
    ttsInitExecutor,
    detectTtsModel,
    nativeBatchTtsCatalogHints
  )

  private val audioExportService = TtsAudioExportService(context, encodeMonoFromRawFile)

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

  fun generateTts(instanceId: String, text: String, options: ReadableMap?, promise: Promise) =
    batchGenerationService.generateTts(instanceId, text, options, promise)

  fun generateTtsWithTimestamps(instanceId: String, text: String, options: ReadableMap?, promise: Promise) =
    batchGenerationService.generateTtsWithTimestamps(instanceId, text, options, promise)

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

  fun startTtsPcmPlayer(instanceId: String, sampleRate: Double, channels: Double, promise: Promise) =
    pcmPlaybackService.startTtsPcmPlayer(instanceId, sampleRate, channels, promise)

  fun writeTtsPcmChunk(instanceId: String, samples: ReadableArray, promise: Promise) =
    pcmPlaybackService.writeTtsPcmChunk(instanceId, samples, promise)

  fun stopTtsPcmPlayer(instanceId: String, promise: Promise) =
    pcmPlaybackService.stopTtsPcmPlayer(instanceId, promise)

  fun getTtsSampleRate(instanceId: String, promise: Promise) =
    lifecycleService.getTtsSampleRate(instanceId, promise)

  fun getTtsNumSpeakers(instanceId: String, promise: Promise) =
    lifecycleService.getTtsNumSpeakers(instanceId, promise)

  fun unloadTts(instanceId: String, promise: Promise) =
    lifecycleService.unloadTts(instanceId, promise)

  fun saveTtsAudio(
    samples: ReadableArray,
    sampleRate: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) = audioExportService.saveTtsAudio(
    samples,
    sampleRate,
    destinationType,
    pathOrDirectoryUri,
    filename,
    format,
    outputSampleRateHz,
    promise
  )

  fun detectTtsModel(modelDir: String, modelType: String?, promise: Promise) =
    lifecycleService.detectTtsModel(modelDir, modelType, promise)

  fun batchTtsCatalogHints(ids: ReadableArray, promise: Promise) =
    lifecycleService.batchTtsCatalogHints(ids, promise)
}
