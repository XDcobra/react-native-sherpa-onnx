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
  fun startTtsPipeline(
    instanceId: String,
    textInLiveBufferId: String,
    audioOutLiveBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) = core.startTtsPipeline(instanceId, textInLiveBufferId, audioOutLiveBufferId, options, promise)
}
