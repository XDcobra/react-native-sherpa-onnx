package com.sherpaonnx.tts.facade

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.tts.core.SherpaOnnxTtsCoordinator

/**
 * Common TTS facade: init, shutdown, detect/catalog, metadata, unload ([SherpaOnnxTtsCoordinator]).
 */
internal class SherpaOnnxCommonTtsHelper(
  private val core: SherpaOnnxTtsCoordinator
) {
  fun initializeTts(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) = core.initializeTts(instanceId, options, promise)

  fun shutdown() = core.shutdown()

  fun detectTtsModel(modelDir: String, assetName: String?, modelType: String?, promise: Promise) =
    core.detectTtsModel(modelDir, assetName, modelType, promise)

  fun getTtsSampleRate(instanceId: String, promise: Promise) =
    core.getTtsSampleRate(instanceId, promise)

  fun getTtsNumSpeakers(instanceId: String, promise: Promise) =
    core.getTtsNumSpeakers(instanceId, promise)

  fun unloadTts(instanceId: String, promise: Promise) =
    core.unloadTts(instanceId, promise)
}
