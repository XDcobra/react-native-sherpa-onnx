package com.sherpaonnx.tts.system

/**
 * Runtime configuration for [SherpaOnnxTextToSpeechService].
 * App layer supplies model paths, voices, locale/sample maps, and synthesis hooks.
 */
data class SystemTtsConfig(
  val modelDir: String,
  val modelType: String,
  val paths: Map<String, String>,
  /** ISO 639-1 hints from native detect (`iso6391Hint`); `na` should be omitted by the caller. */
  val languageHints: List<String>,
  /**
   * App-owned hint → default BCP-47 tag (e.g. `de` → `de-DE`). Must cover every entry in
   * [languageHints].
   */
  val localeTagByHint: Map<String, String>,
  val voiceDescriptors: List<SystemTtsVoiceDescriptor>,
  val numThreads: Int = 2,
  val defaultVoiceName: String,
  val synthesisSpeed: Float = 1.0f,
  val preferencesName: String = "sherpa_system_tts",
  val defaultVoicePreferenceKey: String = "default_voice_name",
  /** Shown when synthesis runs before the on-disk model is ready (app-specific copy). */
  val modelMissingMessage: String = "Speech model is not installed.",
  /**
   * Preview phrases for [android.speech.tts.TextToSpeech.Engine.ACTION_GET_SAMPLE_TEXT], keyed by
   * ISO 639-1 hint. Omit hints to decline preview for that locale.
   */
  val sampleTextByHint: Map<String, String> = emptyMap(),
  /**
   * Optional [com.k2fsa.sherpa.onnx.GenerationConfig.extra] entries per synthesis lang hint
   * (e.g. Supertonic `{ lang: hint }`). Empty map → plain `generate(text, sid, speed)`.
   */
  val synthesisExtrasForLangHint: (langHint: String) -> Map<String, String> = { emptyMap() },
)
