package com.sherpaonnx.tts.system

import android.content.Context
import android.content.pm.ApplicationInfo
import android.media.AudioFormat
import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.util.Log
import com.sherpaonnx.tts.nativeapi.TtsNative
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Synchronous synthesis for Android [android.speech.tts.TextToSpeechService].
 * Loads shared CXX OfflineTts lazily on the binder thread; no React Native bridge.
 */
class SystemTtsSynthesisController(
  private val appContext: Context,
  config: SystemTtsConfig?,
) {
  private val config: SystemTtsConfig? = config
  private val registry: SystemTtsVoiceRegistry? =
    config?.let { SystemTtsVoiceRegistry(it) }
  private val initLock = Any()
  @Volatile
  private var engineReady: Boolean = false
  private val stopRequested = AtomicBoolean(false)
  private val instanceId = TtsNative.SYSTEM_INSTANCE_ID

  fun isModelReady(): Boolean = config != null

  fun languageAvailability(lang: String?, country: String?, variant: String?): Int {
    if (registry == null) {
      SystemTtsLog.w(
        "languageAvailability ${SystemTtsLog.langRequest(lang, country, variant)} " +
          "-> LANG_NOT_SUPPORTED (no config)",
      )
      return TextToSpeech.LANG_NOT_SUPPORTED
    }
    return registry.languageAvailability(lang, country, variant)
  }

  fun loadLanguage(lang: String?, country: String?, variant: String?): Int {
    val status = languageAvailability(lang, country, variant)
    if (status != TextToSpeech.LANG_NOT_SUPPORTED) {
      warmupEngine()
    }
    return status
  }

  fun catalogVoices(): List<android.speech.tts.Voice> {
    val voices = registry?.catalogVoices() ?: emptyList()
    if (registry == null) {
      SystemTtsLog.w("catalogVoices -> empty (no config)")
    }
    return voices
  }

  /** Default engine language for [android.speech.tts.TextToSpeechService.onGetLanguage] (ISO 639-2/T). */
  fun defaultLanguage(): Array<String> {
    val cfg = config
    if (cfg == null) {
      SystemTtsLog.w("defaultLanguage -> empty (no config)")
      return arrayOf("", "", "")
    }
    val hints =
      SystemTtsLocaleMapping.normalizeHints(cfg.languageHints, cfg.localeTagByHint)
    if (hints.isEmpty()) {
      SystemTtsLog.w("defaultLanguage -> empty (no hints)")
      return arrayOf("", "", "")
    }
    return SystemTtsLocaleMapping.ttsLanguageTripleForHint(hints.first(), cfg.localeTagByHint)
  }

  fun isValidVoice(voiceName: String): Boolean =
    registry?.isValidVoiceName(voiceName) == true

  fun loadVoice(voiceName: String): Int =
    if (isValidVoice(voiceName)) TextToSpeech.SUCCESS else TextToSpeech.ERROR_INVALID_REQUEST

  fun defaultVoiceNameFor(lang: String?, country: String?, variant: String?): String {
    val voice = registry?.defaultLocaleTagFor(lang, country, variant).orEmpty()
    if (voice.isEmpty() && registry != null) {
      SystemTtsLog.w(
        "defaultVoiceNameFor ${SystemTtsLog.langRequest(lang, country, variant)} -> empty",
      )
    }
    return voice
  }

  fun synthesize(request: SynthesisRequest, callback: SynthesisCallback) {
    stopRequested.set(false)
    val cfg = config
    if (cfg == null || registry == null) {
      Log.w(TAG, config?.modelMissingMessage ?: "Speech model is not installed.")
      callback.error(TextToSpeech.ERROR_NOT_INSTALLED_YET)
      return
    }

    val text = request.charSequenceText?.toString()?.trim().orEmpty()
    if (text.isEmpty()) {
      try {
        ensureEngine(cfg)
        val sampleRate = TtsNative.nativeGetSampleRate(instanceId)
        if (sampleRate <= 0) {
          Log.e(TAG, "empty-text probe rejected: invalid sampleRate=$sampleRate")
          callback.error(TextToSpeech.ERROR_SYNTHESIS)
          return
        }
        if (startCallback(callback, sampleRate)) {
          callback.done()
        }
      } catch (e: Exception) {
        Log.e(TAG, "empty-text probe failed", e)
        callback.error(TextToSpeech.ERROR_SYNTHESIS)
      }
      return
    }

    val prefs = appContext.getSharedPreferences(cfg.preferencesName, Context.MODE_PRIVATE)
    val preferredBaseVoice = prefs.getString(cfg.defaultVoicePreferenceKey, null)
    val voiceName =
      request.voiceName?.trim()?.takeIf { it.isNotEmpty() }
        ?: defaultVoiceNameFor(request.language, request.country, request.variant)
    if (voiceName.isNullOrEmpty()) {
      Log.e(
        TAG,
        "synthesis rejected: no voice for ${SystemTtsLog.langRequest(request.language, request.country, request.variant)}",
      )
      callback.error(TextToSpeech.ERROR_INVALID_REQUEST)
      return
    }

    val sid = registry.resolveSid(voiceName, preferredBaseVoice)
    if (sid == null) {
      Log.e(
        TAG,
        "synthesis rejected: unresolved sid voice=$voiceName preferredBase=$preferredBaseVoice",
      )
      callback.error(TextToSpeech.ERROR_INVALID_REQUEST)
      return
    }

    val langHint = registry.synthesisLangForRequest(request.language, request.country)
    if (langHint.isNullOrBlank()) {
      Log.e(
        TAG,
        "synthesis rejected: no lang hint for ${SystemTtsLog.langRequest(request.language, request.country, request.variant)}",
      )
      callback.error(TextToSpeech.ERROR_INVALID_REQUEST)
      return
    }

    val speed = resolveSpeechSpeed(request, cfg)

    Log.i(
      TAG,
      "synthesize textLen=${text.length} lang=${request.language} country=${request.country} " +
        "voice=$voiceName sid=$sid langHint=$langHint speed=$speed speechRate=${request.speechRate}",
    )

    try {
      ensureEngine(cfg)
      val sampleRate = TtsNative.nativeGetSampleRate(instanceId)
      if (sampleRate <= 0) {
        Log.e(TAG, "synthesis rejected: invalid engine sampleRate=$sampleRate")
        callback.error(TextToSpeech.ERROR_SYNTHESIS)
        return
      }
      if (!startCallback(callback, sampleRate)) {
        return
      }

      val extras = cfg.synthesisExtrasForLangHint(langHint)
      val audioPair =
        if (extras.isEmpty()) {
          TtsNative.readAudioResult(
            TtsNative.nativeGenerate(instanceId, text, sid, speed)
          )
        } else {
          TtsNative.readAudioResult(
            TtsNative.nativeGenerateWithOptions(
              instanceId = instanceId,
              text = text,
              sid = sid,
              speed = speed,
              applyNumSteps = false,
              numSteps = 5,
              silenceScale = 0.2f,
              referenceAudio = null,
              referenceSampleRate = 0,
              referenceText = null,
              extra = HashMap(extras),
              phonemeCodepoints = null,
              tokens = null,
            )
          )
        }

      if (audioPair == null) {
        Log.e(TAG, "Synthesis returned no audio samples")
        callback.error(TextToSpeech.ERROR_SYNTHESIS)
        return
      }

      val (samples, rate) = audioPair
      Log.i(TAG, "synthesis done samples=${samples.size} sampleRate=$rate")
      streamPcm(callback, samples, rate, alreadyStarted = true)
    } catch (e: Exception) {
      Log.e(TAG, "System TTS synthesis failed", e)
      callback.error(TextToSpeech.ERROR_SYNTHESIS)
    }
  }

  fun stop() {
    stopRequested.set(true)
  }

  fun release() {
    synchronized(initLock) {
      TtsNative.nativeUnload(instanceId)
      engineReady = false
    }
  }

  fun warmupEngine() {
    val cfg = config ?: return
    try {
      ensureEngine(cfg)
      Log.i(TAG, "Engine warmup complete sampleRate=${TtsNative.nativeGetSampleRate(instanceId)}")
    } catch (e: Exception) {
      Log.e(TAG, "Engine warmup failed", e)
    }
  }

  private fun resolveSpeechSpeed(request: SynthesisRequest, cfg: SystemTtsConfig): Float {
    val rate = request.speechRate
    val effectiveRate = if (rate > 0) rate else ANDROID_NEUTRAL_SPEECH_RATE
    return cfg.synthesisSpeed * (effectiveRate / 100f)
  }

  private fun startCallback(callback: SynthesisCallback, sampleRate: Int): Boolean {
    val code =
      callback.start(
        sampleRate,
        AudioFormat.ENCODING_PCM_16BIT,
        1,
      )
    if (code != TextToSpeech.SUCCESS) {
      Log.e(TAG, "callback.start failed code=$code sampleRate=$sampleRate")
      callback.error(TextToSpeech.ERROR_SYNTHESIS)
      return false
    }
    return true
  }

  private fun isDebugBuild(): Boolean =
    (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  private fun ensureEngine(cfg: SystemTtsConfig) {
    synchronized(initLock) {
      if (engineReady && TtsNative.nativeHasInstance(instanceId)) {
        return
      }
      Log.i(TAG, "Loading TTS modelType=${cfg.modelType} dir=${cfg.modelDir}")
      val err = TtsNative.initError(
        TtsNative.nativeInitializeCustom(
          instanceId = instanceId,
          modelType = cfg.modelType,
          paths = HashMap(cfg.paths),
          numThreads = cfg.numThreads,
          debug = isDebugBuild(),
          noiseScale = 0.667f,
          noiseScaleW = 0.8f,
          lengthScale = 1.0f,
          ruleFsts = null,
          ruleFars = null,
          maxNumSentences = 1,
          silenceScale = 0.2f,
          provider = "cpu",
          kokoroLang = null,
        )
      )
      if (err != null) {
        throw IllegalStateException("System TTS init failed: $err")
      }
      engineReady = true
      Log.i(
        TAG,
        "TTS ready sampleRate=${TtsNative.nativeGetSampleRate(instanceId)} " +
          "numSpeakers=${TtsNative.nativeGetNumSpeakers(instanceId)}",
      )
    }
  }

  private fun streamPcm(
    callback: SynthesisCallback,
    samples: FloatArray,
    sampleRate: Int,
    alreadyStarted: Boolean,
  ) {
    if (!alreadyStarted) {
      if (!startCallback(callback, sampleRate)) {
        return
      }
    }

    val pcm = floatArrayToPcm16(samples)
    var offset = 0
    while (offset < pcm.size) {
      if (stopRequested.get()) {
        callback.done()
        return
      }
      val max = callback.maxBufferSize.coerceAtLeast(2)
      var writeLen = minOf(PCM_CHUNK_BYTES, pcm.size - offset, max)
      writeLen = writeLen and 0xFFFFFFFE.toInt()
      if (writeLen <= 0) {
        break
      }
      val code = callback.audioAvailable(pcm, offset, writeLen)
      if (code != TextToSpeech.SUCCESS) {
        Log.e(TAG, "callback.audioAvailable failed code=$code at offset=$offset")
        callback.error(TextToSpeech.ERROR_SYNTHESIS)
        return
      }
      offset += writeLen
    }
    callback.done()
  }

  companion object {
    private const val TAG = SystemTtsLog.TAG
    private const val ANDROID_NEUTRAL_SPEECH_RATE = 100
    private const val PCM_CHUNK_BYTES = 8192

    internal fun floatArrayToPcm16(samples: FloatArray): ByteArray {
      val out = ByteArray(samples.size * 2)
      var i = 0
      for (sample in samples) {
        val clamped = sample.coerceIn(-1.0f, 1.0f)
        val s = (clamped * 32767.0f).toInt().toShort()
        out[i++] = (s.toInt() and 0xff).toByte()
        out[i++] = ((s.toInt() shr 8) and 0xff).toByte()
      }
      return out
    }
  }
}
