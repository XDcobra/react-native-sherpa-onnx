package com.sherpaonnx.tts.system

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech

/**
 * Handles [android.speech.tts.TextToSpeech.Engine.ACTION_GET_SAMPLE_TEXT]. Android system TTS
 * settings will not call [android.speech.tts.TextToSpeech.speak] for preview until this returns
 * a non-null `sampleText` (otherwise [android.speech.tts.TextToSpeechSettings] keeps
 * `mSampleText == null` and the play button does nothing).
 */
abstract class SherpaOnnxGetSampleTextActivity : Activity() {
  protected abstract fun loadConfig(): SystemTtsConfig?

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val lang = intent.getStringExtra("language")
    val country = intent.getStringExtra("country")
    val variant = intent.getStringExtra("variant")
    SystemTtsLog.i(
      "GET_SAMPLE_TEXT ${SystemTtsLog.langRequest(lang, country, variant)}",
    )

    val config = loadConfig()
    val sample =
      config
        ?.let { SystemTtsVoiceRegistry(it) }
        ?.sampleTextForRequest(lang, country, variant)
    if (sample.isNullOrBlank()) {
      SystemTtsLog.w(
        "GET_SAMPLE_TEXT -> LANG_NOT_SUPPORTED " +
          SystemTtsLog.langRequest(lang, country, variant),
      )
      setResult(TextToSpeech.LANG_NOT_SUPPORTED)
      finish()
      return
    }

    SystemTtsLog.i("GET_SAMPLE_TEXT -> sampleLen=${sample.length}")
    val data = Intent()
    data.putExtra("sampleText", sample)
    setResult(TextToSpeech.LANG_AVAILABLE, data)
    finish()
  }
}
