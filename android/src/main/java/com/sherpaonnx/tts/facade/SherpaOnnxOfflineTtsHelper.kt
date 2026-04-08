package com.sherpaonnx.tts.facade

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.tts.core.SherpaOnnxTtsHelper

/**
 * Offline/batch-facing TTS facade.
 * Delegates to [SherpaOnnxTtsCoordinator] (see [SherpaOnnxTtsHelper] typealias).
 */
internal class SherpaOnnxOfflineTtsHelper(
  private val core: SherpaOnnxTtsHelper
) {
  fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) = core.updateTtsParams(instanceId, noiseScale, noiseScaleW, lengthScale, promise)

  fun generateTts(
    instanceId: String,
    text: String,
    options: ReadableMap?,
    promise: Promise
  ) = core.generateTts(instanceId, text, options, promise)

  fun generateTtsWithTimestamps(
    instanceId: String,
    text: String,
    options: ReadableMap?,
    promise: Promise
  ) = core.generateTtsWithTimestamps(instanceId, text, options, promise)

  fun getTtsSamples(
    instanceId: String,
    generation: Double,
    promise: Promise
  ) = core.getTtsSamples(instanceId, generation, promise)

  fun saveTtsAudioFromSink(
    instanceId: String,
    generation: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) = core.saveTtsAudioFromSink(
    instanceId, generation, destinationType, pathOrDirectoryUri,
    filename, format, outputSampleRateHz, promise
  )

  fun saveTtsAudioFromPCM(
    samples: com.facebook.react.bridge.ReadableArray,
    sampleRate: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) = core.saveTtsAudioFromPCM(
    samples,
    sampleRate,
    destinationType,
    pathOrDirectoryUri,
    filename,
    format,
    outputSampleRateHz,
    promise
  )
}
