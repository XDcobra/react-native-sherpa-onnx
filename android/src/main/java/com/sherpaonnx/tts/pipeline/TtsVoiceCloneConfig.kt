package com.sherpaonnx.tts.pipeline

/**
 * Pocket TTS voice-clone inputs for [TtsOfflineLivePipelineWorker], built in
 * [com.sherpaonnx.tts.core.SherpaOnnxTtsCoordinator] from offline reference audio.
 */
internal data class TtsVoiceCloneConfig(
  val referenceAudio: FloatArray,
  val referenceSampleRate: Int,
  val referenceText: String,
  val silenceScale: Float,
  val numSteps: Int,
)
