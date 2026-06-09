package com.sherpaonnx.tts.system

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech

/**
 * Handles [android.speech.tts.TextToSpeech.Engine.ACTION_CHECK_TTS_DATA]. Android system TTS
 * settings builds the language dropdown from [android.speech.tts.TextToSpeech.Engine.EXTRA_AVAILABLE_VOICES]
 * returned here — not from [android.speech.tts.TextToSpeechService.onGetVoices].
 */
abstract class SherpaOnnxCheckVoiceDataActivity : Activity() {
  protected abstract fun loadConfig(): SystemTtsConfig?

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val requested =
      intent.getStringArrayListExtra(TextToSpeech.Engine.EXTRA_CHECK_VOICE_DATA_FOR)
    SystemTtsLog.i(
      "CHECK_TTS_DATA start requested=${requested?.size ?: 0} " +
        SystemTtsLog.joinLimited(requested.orEmpty()),
    )

    val config = loadConfig()
    val registry = config?.let { SystemTtsVoiceRegistry(it) }
    val supported = registry?.checkVoiceDataStrings().orEmpty()
    SystemTtsLog.i(
      "CHECK_TTS_DATA modelReady=${config != null} supported=${supported.size} " +
        SystemTtsLog.joinLimited(supported),
    )

    val available = ArrayList<String>()
    if (registry == null || supported.isEmpty()) {
      SystemTtsLog.w("CHECK_TTS_DATA: model not ready (supported=${supported.size})")
    } else if (requested.isNullOrEmpty()) {
      available.addAll(supported)
    } else {
      for (entry in requested) {
        val resolved = registry.resolveCheckVoiceDataEntry(entry, supported)
        SystemTtsLog.i(
          "CHECK_TTS_DATA match requested=$entry -> ${resolved ?: "no match"}",
        )
        resolved?.let { available.add(it) }
      }
    }

    val resultCode =
      if (available.isNotEmpty()) {
        TextToSpeech.Engine.CHECK_VOICE_DATA_PASS
      } else {
        TextToSpeech.Engine.CHECK_VOICE_DATA_FAIL
      }

    SystemTtsLog.i(
      "CHECK_TTS_DATA result=${if (resultCode == TextToSpeech.Engine.CHECK_VOICE_DATA_PASS) "PASS" else "FAIL"} " +
        "available=${available.size} ${SystemTtsLog.joinLimited(available)}",
    )

    val returnData = Intent()
    returnData.putStringArrayListExtra(TextToSpeech.Engine.EXTRA_AVAILABLE_VOICES, available)
    returnData.putStringArrayListExtra(
      TextToSpeech.Engine.EXTRA_UNAVAILABLE_VOICES,
      ArrayList(),
    )
    setResult(resultCode, returnData)
    finish()
  }
}
