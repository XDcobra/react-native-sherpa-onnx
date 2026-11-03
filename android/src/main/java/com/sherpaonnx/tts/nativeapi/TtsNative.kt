package com.sherpaonnx.tts.nativeapi

/**
 * JNI bridge to shared CXX [sherpaonnx::TtsWrapper].
 * Used by RN TTS services and System TTS.
 */
internal object TtsNative {
  const val SYSTEM_INSTANCE_ID = "__system_tts__"

  fun gateKey(instanceId: String): String = "tts:$instanceId"

  @JvmStatic
  external fun nativeInitializeCustom(
    instanceId: String,
    modelType: String,
    paths: HashMap<String, String>,
    numThreads: Int,
    debug: Boolean,
    noiseScale: Float,
    noiseScaleW: Float,
    lengthScale: Float,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Int,
    silenceScale: Float,
    provider: String?,
    kokoroLang: String?,
  ): HashMap<String, Any>?

  @JvmStatic
  external fun nativeGenerate(
    instanceId: String,
    text: String,
    sid: Int,
    speed: Float,
  ): HashMap<String, Any>?

  /**
   * GenerationConfig path (clone and/or numSteps/extra/phonemes).
   * Pass empty [referenceAudio] and referenceSampleRate=0 for non-clone config.
   */
  @JvmStatic
  external fun nativeGenerateWithOptions(
    instanceId: String,
    text: String,
    sid: Int,
    speed: Float,
    applyNumSteps: Boolean,
    numSteps: Int,
    silenceScale: Float,
    referenceAudio: FloatArray?,
    referenceSampleRate: Int,
    referenceText: String?,
    extra: HashMap<String, String>?,
    phonemeCodepoints: Array<IntArray>?,
    tokens: Array<Array<String>>?,
  ): HashMap<String, Any>?

  @JvmStatic
  external fun nativeGetSampleRate(instanceId: String): Int

  @JvmStatic
  external fun nativeGetNumSpeakers(instanceId: String): Int

  @JvmStatic
  external fun nativeHasInstance(instanceId: String): Boolean

  @JvmStatic
  external fun nativeUnload(instanceId: String)

  @JvmStatic
  external fun nativeShutdownAll()

  fun readAudioResult(raw: HashMap<String, Any>?): Pair<FloatArray, Int>? {
    if (raw == null) return null
    val ok = raw["success"] as? Boolean ?: false
    if (!ok) return null
    val samples = raw["samples"] as? FloatArray ?: return null
    val rate = (raw["sampleRate"] as? Number)?.toInt() ?: 0
    if (samples.isEmpty() || rate <= 0) return null
    return samples to rate
  }

  fun initError(raw: HashMap<String, Any>?): String? {
    if (raw == null) return "native init returned null"
    val ok = raw["success"] as? Boolean ?: false
    if (ok) return null
    return raw["error"] as? String ?: "TTS init failed"
  }
}
