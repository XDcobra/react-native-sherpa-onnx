package com.sherpaonnx

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.fbreact.specs.NativeSherpaOnnxSpec

@ReactModule(name = SherpaOnnxModule.NAME)
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
  NativeSherpaOnnxSpec(reactContext) {

  init {
    // Load sherpa-onnx JNI first (from AAR; required for Kotlin API: OfflineRecognizer, OfflineTts, etc.)
    try {
      System.loadLibrary("sherpa-onnx-jni")
    } catch (e: UnsatisfiedLinkError) {
      throw RuntimeException("Failed to load sherpa-onnx-jni (from sherpa-onnx AAR): ${e.message}", e)
    }
    // Then load our library (Archive, FFmpeg, model detection)
    System.loadLibrary("sherpaonnx")
    instance = this
  }

  private val coreHelper = SherpaOnnxCoreHelper(reactApplicationContext, NAME)
  private val sttHelper = SherpaOnnxSttHelper(
    object : SherpaOnnxSttHelper.NativeSttBridge {
      override fun detectSttModel(
        modelDir: String,
        preferInt8: Boolean,
        hasPreferInt8: Boolean,
        modelType: String,
        debug: Boolean
      ): HashMap<String, Any>? {
        return Companion.nativeDetectSttModel(modelDir, preferInt8, hasPreferInt8, modelType, debug)
      }
    },
    NAME
  )
  private val ttsHelper = SherpaOnnxTtsHelper(
    reactApplicationContext,
    object : SherpaOnnxTtsHelper.NativeTtsBridge {
      override fun detectTtsModel(modelDir: String, modelType: String): HashMap<String, Any>? {
        return Companion.nativeDetectTtsModel(modelDir, modelType)
      }
    },
    ::emitTtsStreamChunk,
    ::emitTtsStreamError,
    ::emitTtsStreamEnd
  )
  private val archiveHelper = SherpaOnnxArchiveHelper()

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

  override fun extractTarBz2(sourcePath: String, targetPath: String, force: Boolean, promise: Promise) {
    archiveHelper.extractTarBz2(sourcePath, targetPath, force, promise) { bytes, total, percent ->
      emitExtractProgress(bytes, total, percent)
    }
  }

  override fun cancelExtractTarBz2(promise: Promise) {
    archiveHelper.cancelExtractTarBz2()
    promise.resolve(null)
  }

  override fun computeFileSha256(filePath: String, promise: Promise) {
    archiveHelper.computeFileSha256(filePath, promise)
  }

  private fun emitExtractProgress(bytes: Long, totalBytes: Long, percent: Double) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putDouble("bytes", bytes.toDouble())
    payload.putDouble("totalBytes", totalBytes.toDouble())
    payload.putDouble("percent", percent)
    eventEmitter.emit("extractTarBz2Progress", payload)
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
    debug: Boolean?,
    promise: Promise
  ) {
    sttHelper.initializeSherpaOnnx(modelDir, preferInt8, modelType, debug, promise)
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

  /**
   * Convert any supported audio file to a requested format using native FFmpeg prebuilts.
   * For MP3, outputSampleRateHz can be 32000, 44100, or 48000; null/0 = 44100. WAV output is always 16 kHz mono.
   * Resolves with null on success, rejects with an error message on failure.
   */
  override fun convertAudioToFormat(inputPath: String, outputPath: String, format: String, outputSampleRateHz: Double?, promise: Promise) {
    try {
      var rate = outputSampleRateHz?.toInt() ?: 0

      if (rate < 0) {
        promise.reject("CONVERT_ERROR", "Invalid outputSampleRateHz: must be >= 0")
        return
      }

      if (format.equals("mp3", ignoreCase = true)) {
        val allowed = setOf(0, 32000, 44100, 48000)
        if (!allowed.contains(rate)) {
          promise.reject(
            "CONVERT_ERROR",
            "MP3 output sample rate must be one of 32000, 44100, 48000, or 0 (default). Received: $rate"
          )
          return
        }
      } else {
        rate = rate.coerceIn(0, 48000)
      }

      val err = Companion.nativeConvertAudioToFormat(inputPath, outputPath, format, rate)
      if (err.isEmpty()) {
        promise.resolve(null)
      } else {
        promise.reject("CONVERT_ERROR", err)
      }
    } catch (e: Exception) {
      promise.reject("CONVERT_EXCEPTION", "Failed to convert audio: ${e.message}", e)
    }
  }

  /**
   * Convert any supported audio file to WAV 16 kHz mono 16-bit PCM using native FFmpeg prebuilts.
   * Resolves with null on success, rejects with an error message on failure.
   */
  override fun convertAudioToWav16k(inputPath: String, outputPath: String, promise: Promise) {
    try {
      val err = Companion.nativeConvertAudioToWav16k(inputPath, outputPath)
      if (err.isEmpty()) {
        promise.resolve(null)
      } else {
        promise.reject("CONVERT_ERROR", err)
      }
    } catch (e: Exception) {
      promise.reject("CONVERT_EXCEPTION", "Failed to convert audio to WAV16k: ${e.message}", e)
    }
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
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    ttsHelper.initializeTts(
      modelDir,
      modelType,
      numThreads,
      debug,
      noiseScale,
      noiseScaleW,
      lengthScale,
      promise
    )
  }

  /**
   * Update TTS params by re-initializing with stored config.
   */
  override fun updateTtsParams(
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    ttsHelper.updateTtsParams(noiseScale, noiseScaleW, lengthScale, promise)
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

  /**
   * List model folders under a specific filesystem path.
   */
  override fun listModelsAtPath(path: String, recursive: Boolean, promise: Promise) {
    coreHelper.listModelsAtPath(path, recursive, promise)
  }

  override fun getAssetPackPath(packName: String, promise: Promise) {
    coreHelper.getAssetPackPath(packName, promise)
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

    /** Model detection for STT: returns HashMap with success, error, detectedModels, modelType, paths (for Kotlin API config). */
    @JvmStatic
    private external fun nativeDetectSttModel(
      modelDir: String,
      preferInt8: Boolean,
      hasPreferInt8: Boolean,
      modelType: String,
      debug: Boolean
    ): HashMap<String, Any>?

    /** Model detection for TTS: returns HashMap with success, error, detectedModels, modelType, paths (for Kotlin API config). */
    @JvmStatic
    private external fun nativeDetectTtsModel(modelDir: String, modelType: String): HashMap<String, Any>?

    /** Convert arbitrary audio file to requested format (e.g. "mp3", "flac", "wav").
     * outputSampleRateHz: for MP3 use 32000/44100/48000, 0 = default 44100. Ignored for WAV/FLAC.
     * Returns empty string on success, or an error message otherwise. Requires FFmpeg prebuilts when called on Android.
     */
    @JvmStatic
    private external fun nativeConvertAudioToFormat(inputPath: String, outputPath: String, format: String, outputSampleRateHz: Int): String

    /** Convert any supported audio file to WAV 16 kHz mono 16-bit PCM. Returns empty string on success, error message otherwise. Requires FFmpeg prebuilts. */
    @JvmStatic
    private external fun nativeConvertAudioToWav16k(inputPath: String, outputPath: String): String
  }
}
