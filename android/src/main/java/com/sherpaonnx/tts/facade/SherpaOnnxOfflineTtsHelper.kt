package com.sherpaonnx.tts.facade

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.tts.core.SherpaOnnxTtsCoordinator

/**
 * Offline/batch-facing TTS facade.
 * Delegates to [SherpaOnnxTtsCoordinator].
 */
internal class SherpaOnnxOfflineTtsHelper(
  private val core: SherpaOnnxTtsCoordinator
) {
  fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) = core.updateTtsParams(instanceId, noiseScale, noiseScaleW, lengthScale, promise)

  fun synthesizeTts(
    instanceId: String,
    textInBufferId: String,
    audioOutBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) = core.synthesizeTts(instanceId, textInBufferId, audioOutBufferId, options, promise)
}
