package com.sherpaonnx

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

@ReactModule(name = SherpaOnnxModule.NAME)
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
  NativeSherpaOnnxSpec(reactContext) {

  init {
    System.loadLibrary("sherpaonnx")
    instance = this
  }

  private val coreHelper = SherpaOnnxCoreHelper(reactApplicationContext, NAME)
  private val sttHelper = SherpaOnnxSttHelper(
    object : SherpaOnnxSttHelper.NativeSttBridge {
      override fun nativeSttInitialize(
        modelDir: String,
        preferInt8: Boolean,
        hasPreferInt8: Boolean,
        modelType: String
      ): HashMap<String, Any>? {
        return Companion.nativeSttInitialize(modelDir, preferInt8, hasPreferInt8, modelType)
      }

      override fun nativeSttTranscribe(filePath: String): String {
        return Companion.nativeSttTranscribe(filePath)
      }

      override fun nativeSttRelease() {
        Companion.nativeSttRelease()
      }
    },
    NAME
  )
  private val ttsHelper = SherpaOnnxTtsHelper(
    reactApplicationContext,
    object : SherpaOnnxTtsHelper.NativeTtsBridge {
      override fun nativeTtsInitialize(
        modelDir: String,
        modelType: String,
        numThreads: Int,
        debug: Boolean,
        noiseScale: Double,
        lengthScale: Double
      ): HashMap<String, Any>? {
        return Companion.nativeTtsInitialize(modelDir, modelType, numThreads, debug, noiseScale, lengthScale)
      }

      override fun nativeTtsGenerate(text: String, sid: Int, speed: Float): HashMap<String, Any>? {
        return Companion.nativeTtsGenerate(text, sid, speed)
      }

      override fun nativeTtsGenerateWithTimestamps(
        text: String,
        sid: Int,
        speed: Float
      ): HashMap<String, Any>? {
        return Companion.nativeTtsGenerateWithTimestamps(text, sid, speed)
      }

      override fun nativeTtsGenerateStream(text: String, sid: Int, speed: Float): Boolean {
        return Companion.nativeTtsGenerateStream(text, sid, speed)
      }

      override fun nativeTtsCancelStream() {
        Companion.nativeTtsCancelStream()
      }

      override fun nativeTtsGetSampleRate(): Int {
        return Companion.nativeTtsGetSampleRate()
      }

      override fun nativeTtsGetNumSpeakers(): Int {
        return Companion.nativeTtsGetNumSpeakers()
      }

      override fun nativeTtsRelease() {
        Companion.nativeTtsRelease()
      }

      override fun nativeTtsSaveToWavFile(samples: FloatArray, sampleRate: Int, filePath: String): Boolean {
        return Companion.nativeTtsSaveToWavFile(samples, sampleRate, filePath)
      }
    },
    ::emitTtsStreamChunk,
    ::emitTtsStreamError,
    ::emitTtsStreamEnd
  )

  override fun getName(): String {
    return NAME
  }

  /**
   * Test method to verify sherpa-onnx native library is loaded.
   * This is a minimal "Hello World" test for Phase 1.
   */
  override fun testSherpaInit(promise: Promise) {
    try {
      val result = nativeTestSherpaInit()
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("INIT_ERROR", "Failed to test sherpa-onnx initialization", e)
    }
  }

  /**
   * Resolve model path based on configuration.
   * Handles asset paths, file system paths, and auto-detection.
   */
  override fun resolveModelPath(config: ReadableMap, promise: Promise) {
    coreHelper.resolveModelPath(config, promise)
  }

  /**
   * Resolve asset path - copy from assets to internal storage if needed
   * Preserves the directory structure from assets (e.g., test_wavs/ stays as test_wavs/)
   */

  /**
   * Initialize sherpa-onnx with model directory.
   */
  override fun initializeSherpaOnnx(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    promise: Promise
  ) {
    sttHelper.initializeSherpaOnnx(modelDir, preferInt8, modelType, promise)
  }

  /**
   * Release sherpa-onnx resources.
   */
  override fun unloadSherpaOnnx(promise: Promise) {
    sttHelper.unloadSherpaOnnx(promise)
  }

  // ==================== STT Methods ====================

  /**
   * Transcribe an audio file.
   */
  override fun transcribeFile(filePath: String, promise: Promise) {
    sttHelper.transcribeFile(filePath, promise)
  }

  // ==================== TTS Methods ====================

  /**
   * Initialize TTS with model directory.
   */
  override fun initializeTts(
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    ttsHelper.initializeTts(modelDir, modelType, numThreads, debug, noiseScale, lengthScale, promise)
  }

  /**
   * Update TTS params by re-initializing with stored config.
   */
  override fun updateTtsParams(
    noiseScale: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    ttsHelper.updateTtsParams(noiseScale, lengthScale, promise)
  }

  /**
   * Generate speech from text.
   */
  override fun generateTts(
    text: String,
    sid: Double,
    speed: Double,
    promise: Promise
  ) {
    ttsHelper.generateTts(text, sid, speed, promise)
  }

  /**
   * Generate speech with subtitle/timestamp metadata.
   */
  override fun generateTtsWithTimestamps(
    text: String,
    sid: Double,
    speed: Double,
    promise: Promise
  ) {
    ttsHelper.generateTtsWithTimestamps(text, sid, speed, promise)
  }

  /**
   * Generate speech in streaming mode (emits chunk events).
   */
  override fun generateTtsStream(
    text: String,
    sid: Double,
    speed: Double,
    promise: Promise
  ) {
    ttsHelper.generateTtsStream(text, sid, speed, promise)
  }

  /**
   * Cancel ongoing streaming TTS.
   */
  override fun cancelTtsStream(promise: Promise) {
    ttsHelper.cancelTtsStream(promise)
  }

  /**
   * Start PCM playback for streaming TTS.
   */
  override fun startTtsPcmPlayer(sampleRate: Double, channels: Double, promise: Promise) {
    ttsHelper.startTtsPcmPlayer(sampleRate, channels, promise)
  }

  /**
   * Write PCM samples to the streaming TTS player.
   */
  override fun writeTtsPcmChunk(samples: ReadableArray, promise: Promise) {
    ttsHelper.writeTtsPcmChunk(samples, promise)
  }

  /**
   * Stop PCM playback for streaming TTS.
   */
  override fun stopTtsPcmPlayer(promise: Promise) {
    ttsHelper.stopTtsPcmPlayer(promise)
  }

  private fun emitTtsStreamChunk(
    samples: FloatArray,
    sampleRate: Int,
    progress: Float,
    isFinal: Boolean
  ) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val samplesArray = Arguments.createArray()
    for (sample in samples) {
      samplesArray.pushDouble(sample.toDouble())
    }
    val payload = Arguments.createMap()
    payload.putArray("samples", samplesArray)
    payload.putInt("sampleRate", sampleRate)
    payload.putDouble("progress", progress.toDouble())
    payload.putBoolean("isFinal", isFinal)
    eventEmitter.emit("ttsStreamChunk", payload)
  }

  private fun emitTtsStreamError(message: String) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("message", message)
    eventEmitter.emit("ttsStreamError", payload)
  }

  private fun emitTtsStreamEnd(cancelled: Boolean) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putBoolean("cancelled", cancelled)
    eventEmitter.emit("ttsStreamEnd", payload)
  }

  /**
   * Get TTS sample rate.
   */
  override fun getTtsSampleRate(promise: Promise) {
    ttsHelper.getTtsSampleRate(promise)
  }

  /**
   * Get number of speakers.
   */
  override fun getTtsNumSpeakers(promise: Promise) {
    ttsHelper.getTtsNumSpeakers(promise)
  }

  /**
   * Release TTS resources.
   */
  override fun unloadTts(promise: Promise) {
    ttsHelper.unloadTts(promise)
  }

  /**
   * Save TTS audio samples to a WAV file.
   */
  override fun saveTtsAudioToFile(
    samples: ReadableArray,
    sampleRate: Double,
    filePath: String,
    promise: Promise
  ) {
    ttsHelper.saveTtsAudioToFile(samples, sampleRate, filePath, promise)
  }

  /**
   * Save TTS audio samples to a WAV file via Android SAF content URI.
   */
  override fun saveTtsAudioToContentUri(
    samples: ReadableArray,
    sampleRate: Double,
    directoryUri: String,
    filename: String,
    promise: Promise
  ) {
    ttsHelper.saveTtsAudioToContentUri(samples, sampleRate, directoryUri, filename, promise)
  }

  /**
   * Save text content to a file via Android SAF content URI.
   */
  override fun saveTtsTextToContentUri(
    text: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    ttsHelper.saveTtsTextToContentUri(text, directoryUri, filename, mimeType, promise)
  }

  /**
   * Copy a SAF content URI to a cache file for local playback.
   */
  override fun copyTtsContentUriToCache(
    fileUri: String,
    filename: String,
    promise: Promise
  ) {
    ttsHelper.copyTtsContentUriToCache(fileUri, filename, promise)
  }

  /**
   * Share a TTS audio file (file path or content URI).
   */
  override fun shareTtsAudio(fileUri: String, mimeType: String, promise: Promise) {
    ttsHelper.shareTtsAudio(fileUri, mimeType, promise)
  }

  /**
   * List all model folders in the assets/models directory.
   * Scans the platform-specific model directory and returns folder names.
   */
  override fun listAssetModels(promise: Promise) {
    coreHelper.listAssetModels(promise)
  }
  companion object {
    const val NAME = "SherpaOnnx"

    @Volatile
    private var instance: SherpaOnnxModule? = null

    @JvmStatic
    fun onTtsStreamChunk(
      samples: FloatArray,
      sampleRate: Int,
      progress: Float,
      isFinal: Boolean
    ) {
      instance?.emitTtsStreamChunk(samples, sampleRate, progress, isFinal)
    }

    @JvmStatic
    fun onTtsStreamError(message: String) {
      instance?.emitTtsStreamError(message)
    }

    @JvmStatic
    fun onTtsStreamEnd(cancelled: Boolean) {
      instance?.emitTtsStreamEnd(cancelled)
    }

    // Native JNI methods
    @JvmStatic
    private external fun nativeTestSherpaInit(): String

    @JvmStatic
    private external fun nativeSttInitialize(
      modelDir: String,
      preferInt8: Boolean,
      hasPreferInt8: Boolean,
      modelType: String
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeSttTranscribe(filePath: String): String

    @JvmStatic
    private external fun nativeSttRelease()

    // TTS Native JNI methods
    @JvmStatic
    private external fun nativeTtsInitialize(
      modelDir: String,
      modelType: String,
      numThreads: Int,
      debug: Boolean,
      noiseScale: Double,
      lengthScale: Double
    ): java.util.HashMap<String, Any>?

    @JvmStatic
    private external fun nativeTtsGenerate(
      text: String,
      sid: Int,
      speed: Float
    ): java.util.HashMap<String, Any>?

    @JvmStatic
    private external fun nativeTtsGenerateWithTimestamps(
      text: String,
      sid: Int,
      speed: Float
    ): java.util.HashMap<String, Any>?

    @JvmStatic
    private external fun nativeTtsGenerateStream(
      text: String,
      sid: Int,
      speed: Float
    ): Boolean

    @JvmStatic
    private external fun nativeTtsCancelStream()

    @JvmStatic
    private external fun nativeTtsGetSampleRate(): Int

    @JvmStatic
    private external fun nativeTtsGetNumSpeakers(): Int

    @JvmStatic
    private external fun nativeTtsRelease()

    @JvmStatic
    private external fun nativeTtsSaveToWavFile(
      samples: FloatArray,
      sampleRate: Int,
      filePath: String
    ): Boolean
  }
}
