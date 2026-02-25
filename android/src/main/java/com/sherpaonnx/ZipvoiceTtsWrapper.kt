package com.sherpaonnx

import android.util.Log
import com.k2fsa.sherpa.onnx.GeneratedAudio

/**
 * Kotlin wrapper for Zipvoice TTS via the sherpa-onnx C-API.
 *
 * The official Kotlin API (OfflineTts / OfflineTtsModelConfig) does not expose
 * OfflineTtsZipvoiceModelConfig. This class bypasses the Kotlin API and calls the
 * C-API directly through JNI methods in libsherpaonnx.so.
 *
 * The public API intentionally mirrors [com.k2fsa.sherpa.onnx.OfflineTts] so that
 * [SherpaOnnxTtsHelper] can dispatch to either engine transparently.
 */
internal class ZipvoiceTtsWrapper private constructor(private var ptr: Long) {

  companion object {
    private const val TAG = "ZipvoiceTts"

    /**
     * Create a Zipvoice TTS engine.
     *
     * @return a wrapper instance, or `null` if creation failed (check logcat for details).
     */
    fun create(
      tokens: String,
      encoder: String,
      decoder: String,
      vocoder: String,
      dataDir: String,
      lexicon: String,
      featScale: Float = 0.1f,
      tShift: Float = 0.5f,
      targetRms: Float = 0.1f,
      guidanceScale: Float = 1.0f,
      numThreads: Int = 2,
      debug: Boolean = false,
      ruleFsts: String = "",
      ruleFars: String = "",
      maxNumSentences: Int = 1,
      silenceScale: Float = 0.2f,
      provider: String = "cpu"
    ): ZipvoiceTtsWrapper? {
      val p = nativeCreate(
        tokens, encoder, decoder, vocoder, dataDir, lexicon,
        featScale, tShift, targetRms, guidanceScale,
        numThreads, debug,
        ruleFsts, ruleFars, maxNumSentences, silenceScale,
        provider
      )
      if (p == 0L) {
        Log.e(TAG, "nativeCreate returned 0 — failed to create Zipvoice TTS engine")
        return null
      }
      return ZipvoiceTtsWrapper(p)
    }

    // JNI native methods (implemented in sherpa-onnx-tts-zipvoice-jni.cpp, loaded via libsherpaonnx)
    @JvmStatic
    private external fun nativeCreate(
      tokens: String, encoder: String, decoder: String, vocoder: String,
      dataDir: String, lexicon: String,
      featScale: Float, tShift: Float, targetRms: Float, guidanceScale: Float,
      numThreads: Int, debug: Boolean,
      ruleFsts: String, ruleFars: String, maxNumSentences: Int, silenceScale: Float,
      provider: String
    ): Long

    @JvmStatic
    private external fun nativeDestroy(ptr: Long)

    @JvmStatic
    private external fun nativeGetSampleRate(ptr: Long): Int

    @JvmStatic
    private external fun nativeGetNumSpeakers(ptr: Long): Int

    @JvmStatic
    private external fun nativeGenerate(ptr: Long, text: String, sid: Int, speed: Float): Array<Any>?

    @JvmStatic
    private external fun nativeGenerateWithZipvoice(
      ptr: Long, text: String, promptText: String,
      promptSamples: FloatArray, promptSr: Int,
      speed: Float, numSteps: Int
    ): Array<Any>?
  }

  // Instance method: JNI calls onNativeChunk on this object during generation
  private external fun nativeGenerateWithCallback(ptr: Long, text: String, sid: Int, speed: Float): Array<Any>?

  fun sampleRate(): Int {
    check(ptr != 0L) { "ZipvoiceTtsWrapper already released" }
    return nativeGetSampleRate(ptr)
  }

  fun numSpeakers(): Int {
    check(ptr != 0L) { "ZipvoiceTtsWrapper already released" }
    return nativeGetNumSpeakers(ptr)
  }

  /**
   * Generate audio from text (non-zero-shot, standard TTS).
   * Mirrors [com.k2fsa.sherpa.onnx.OfflineTts.generate].
   */
  fun generate(text: String, sid: Int = 0, speed: Float = 1.0f): GeneratedAudio {
    check(ptr != 0L) { "ZipvoiceTtsWrapper already released" }
    val result = nativeGenerate(ptr, text, sid, speed)
      ?: throw RuntimeException("Zipvoice TTS generate returned null")
    return parseAudioResult(result)
  }

  /**
   * Generate audio with a per-chunk callback for streaming playback.
   * The [callback] receives each audio chunk; return the chunk size to continue, 0 to cancel.
   *
   * Mirrors the callback-based generate in [com.k2fsa.sherpa.onnx.OfflineTts.generateWithCallback].
   */
  fun generateWithCallback(
    text: String,
    sid: Int = 0,
    speed: Float = 1.0f,
    callback: (FloatArray) -> Int
  ): GeneratedAudio {
    check(ptr != 0L) { "ZipvoiceTtsWrapper already released" }
    this.streamCallback = callback
    val result = nativeGenerateWithCallback(ptr, text, sid, speed)
      ?: throw RuntimeException("Zipvoice TTS generateWithCallback returned null")
    this.streamCallback = null
    return parseAudioResult(result)
  }

  /**
   * Zero-shot voice cloning with a reference prompt.
   *
   * @param text            Text to synthesize.
   * @param promptText      Transcript of the reference audio.
   * @param promptSamples   Reference audio samples (mono, [-1, 1]).
   * @param promptSr        Sample rate of [promptSamples].
   * @param speed           Speed factor (1.0 = normal).
   * @param numSteps        Number of flow-matching diffusion steps.
   */
  fun generateWithZipvoice(
    text: String,
    promptText: String,
    promptSamples: FloatArray,
    promptSr: Int,
    speed: Float = 1.0f,
    numSteps: Int = 20
  ): GeneratedAudio {
    check(ptr != 0L) { "ZipvoiceTtsWrapper already released" }
    val result = nativeGenerateWithZipvoice(ptr, text, promptText, promptSamples, promptSr, speed, numSteps)
      ?: throw RuntimeException("Zipvoice TTS generateWithZipvoice returned null")
    return parseAudioResult(result)
  }

  fun release() {
    if (ptr != 0L) {
      nativeDestroy(ptr)
      ptr = 0L
    }
  }

  // -- Streaming callback bridge --
  // Called from JNI (nativeGenerateWithCallback) via the onNativeChunk method.
  @Volatile
  private var streamCallback: ((FloatArray) -> Int)? = null

  /**
   * Invoked from C++ callback. Must be public for JNI access but is not part of the public API.
   * @return true to continue generating, false to cancel.
   */
  @Suppress("unused") // Called from JNI
  fun onNativeChunk(samples: FloatArray, n: Int): Boolean {
    val cb = streamCallback ?: return false
    return cb(samples) != 0
  }

  // -- Internal helpers --

  private fun parseAudioResult(result: Array<Any>): GeneratedAudio {
    val samples = result[0] as FloatArray
    val sampleRate = (result[1] as Number).toInt()
    return GeneratedAudio(samples, sampleRate)
  }
}
