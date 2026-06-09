package com.sherpaonnx.tts.system

/** Maps an Android [android.speech.tts.Voice] name to a sherpa-onnx speaker id (`sid`). */
data class SystemTtsVoiceDescriptor(
  val voiceName: String,
  val sid: Int,
  val displayLabel: String,
)
