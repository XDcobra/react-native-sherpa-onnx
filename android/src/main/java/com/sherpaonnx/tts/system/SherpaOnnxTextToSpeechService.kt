package com.sherpaonnx.tts.system

import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.speech.tts.TextToSpeechService

/**
 * Generic Android system TTS engine base class. Apps subclass and supply [SystemTtsConfig]
 * via [loadConfig] (model dir, voices, locales). No React Native bridge on the synthesis path.
 */
abstract class SherpaOnnxTextToSpeechService : TextToSpeechService() {
  private var controller: SystemTtsSynthesisController? = null

  /** Returns runtime config when the on-disk model is ready; `null` if missing or detect failed. */
  protected abstract fun loadConfig(): SystemTtsConfig?

  private fun controller(): SystemTtsSynthesisController {
    val existing = controller
    if (existing?.isModelReady() == true) {
      return existing
    }
    existing?.release()
    val cfg = loadConfig()
    SystemTtsLog.i(
      "controller reload modelReady=${cfg != null} " +
        "hints=${cfg?.languageHints?.size ?: 0} dir=${cfg?.modelDir ?: "null"}",
    )
    val created = SystemTtsSynthesisController(applicationContext, cfg)
    controller = created
    return created
  }

  /** Call after the on-disk model becomes available (e.g. post-extract broadcast). */
  protected open fun reloadConfig() {
    SystemTtsLog.i("reloadConfig")
    onConfigReloadRequested()
    controller?.release()
    controller = null
  }

  /** App hook to drop cached [loadConfig] state when [reloadConfig] runs. */
  protected open fun onConfigReloadRequested() = Unit

  override fun onGetLanguage(): Array<String> {
    val triple = controller().defaultLanguage()
    SystemTtsLog.i("onGetLanguage -> ${SystemTtsLog.languageTriple(triple)}")
    return triple
  }

  override fun onIsLanguageAvailable(lang: String?, country: String?, variant: String?): Int {
    val code = controller().languageAvailability(lang, country, variant)
    SystemTtsLog.i(
      "onIsLanguageAvailable ${SystemTtsLog.langRequest(lang, country, variant)} " +
        "-> ${SystemTtsLog.langAvailabilityName(code)}",
    )
    return code
  }

  override fun onLoadLanguage(lang: String?, country: String?, variant: String?): Int {
    val code = controller().loadLanguage(lang, country, variant)
    SystemTtsLog.i(
      "onLoadLanguage ${SystemTtsLog.langRequest(lang, country, variant)} " +
        "-> ${SystemTtsLog.langAvailabilityName(code)}",
    )
    return code
  }

  override fun onGetVoices(): List<android.speech.tts.Voice> {
    val voices = controller().catalogVoices()
    val names = voices.map { "${it.name}@${it.locale}" }
    SystemTtsLog.i(
      "onGetVoices -> count=${voices.size} ${SystemTtsLog.joinLimited(names)}",
    )
    return voices
  }

  override fun onIsValidVoiceName(voiceName: String): Int {
    val valid = controller().isValidVoice(voiceName)
    val code =
      if (valid) {
        TextToSpeech.SUCCESS
      } else {
        TextToSpeech.ERROR_INVALID_REQUEST
      }
    SystemTtsLog.i("onIsValidVoiceName voice=$voiceName -> ${if (valid) "SUCCESS" else "ERROR"}")
    return code
  }

  override fun onLoadVoice(voiceName: String): Int {
    val code = controller().loadVoice(voiceName)
    SystemTtsLog.i(
      "onLoadVoice voice=$voiceName -> ${if (code == TextToSpeech.SUCCESS) "SUCCESS" else "ERROR"}",
    )
    return code
  }

  override fun onGetDefaultVoiceNameFor(
    lang: String?,
    country: String?,
    variant: String?,
  ): String {
    val voiceName = controller().defaultVoiceNameFor(lang, country, variant)
    SystemTtsLog.i(
      "onGetDefaultVoiceNameFor ${SystemTtsLog.langRequest(lang, country, variant)} " +
        "-> voice=$voiceName",
    )
    return voiceName
  }

  override fun onSynthesizeText(request: SynthesisRequest, callback: SynthesisCallback) {
    val text = request.charSequenceText?.toString()?.trim().orEmpty()
    SystemTtsLog.i(
      "onSynthesizeText lang=${request.language} country=${request.country} " +
        "voice=${request.voiceName} textLen=${text.length} speechRate=${request.speechRate}",
    )
    controller().synthesize(request, callback)
  }

  override fun onStop() {
    SystemTtsLog.i("onStop")
    controller?.stop()
  }

  override fun onDestroy() {
    SystemTtsLog.i("onDestroy")
    controller?.release()
    controller = null
    super.onDestroy()
  }
}
