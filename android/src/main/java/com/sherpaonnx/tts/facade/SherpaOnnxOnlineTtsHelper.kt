package com.sherpaonnx.tts.facade

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.tts.core.SherpaOnnxTtsHelper

/**
 * Online/streaming-facing TTS facade ([SherpaOnnxTtsCoordinator]).
 */
internal class SherpaOnnxOnlineTtsHelper(
  private val core: SherpaOnnxTtsHelper
) {
  fun generateTtsStream(
    instanceId: String,
    requestId: String,
    text: String,
    options: ReadableMap?,
    promise: Promise
  ) = core.generateTtsStream(instanceId, requestId, text, options, promise)

  fun generateTtsStreamToFile(
    instanceId: String,
    requestId: String,
    text: String,
    options: ReadableMap?,
    fileOptions: ReadableMap?,
    promise: Promise
  ) = core.generateTtsStreamToFile(
    instanceId,
    requestId,
    text,
    options,
    fileOptions,
    promise
  )

  fun cancelTtsStream(instanceId: String, promise: Promise) =
    core.cancelTtsStream(instanceId, promise)

  fun startTtsPcmPlayer(
    instanceId: String,
    sampleRate: Double,
    channels: Double,
    promise: Promise
  ) = core.startTtsPcmPlayer(instanceId, sampleRate, channels, promise)

  fun writeTtsPcmChunk(
    instanceId: String,
    samples: ReadableArray,
    promise: Promise
  ) = core.writeTtsPcmChunk(instanceId, samples, promise)

  fun stopTtsPcmPlayer(instanceId: String, promise: Promise) =
    core.stopTtsPcmPlayer(instanceId, promise)
}
