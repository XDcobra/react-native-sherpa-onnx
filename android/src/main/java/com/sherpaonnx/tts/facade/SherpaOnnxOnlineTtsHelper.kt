package com.sherpaonnx.tts.facade

import com.facebook.react.bridge.Promise
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
}
