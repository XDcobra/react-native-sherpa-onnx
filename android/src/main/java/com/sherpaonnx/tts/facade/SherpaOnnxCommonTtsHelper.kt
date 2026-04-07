package com.sherpaonnx.tts.facade

import com.facebook.react.bridge.Promise
import com.sherpaonnx.tts.core.SherpaOnnxTtsHelper

/**
 * Common TTS facade: init, shutdown, detect/catalog, metadata, unload ([SherpaOnnxTtsCoordinator]).
 */
internal class SherpaOnnxCommonTtsHelper(
  private val core: SherpaOnnxTtsHelper
) {
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
  ) = core.initializeTts(
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
