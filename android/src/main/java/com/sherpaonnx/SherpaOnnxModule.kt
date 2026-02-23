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
    // Load sherpa-onnx C-API (from AAR; needed at runtime only if Zipvoice TTS is used).
    // Non-fatal: if the .so is missing, Zipvoice init will fail with a clear error later.
    try {
      System.loadLibrary("sherpa-onnx-c-api")
    } catch (e: UnsatisfiedLinkError) {
      android.util.Log.w("SherpaOnnx", "sherpa-onnx-c-api not available — Zipvoice TTS will not work: ${e.message}")
    }
    // Then load our library (Archive, FFmpeg, model detection, Zipvoice JNI wrapper)
    System.loadLibrary("sherpaonnx")
    instance = this
  }

  private val coreHelper = SherpaOnnxCoreHelper(reactApplicationContext, NAME)
  private val sttHelper = SherpaOnnxSttHelper(
    reactApplicationContext,
    { modelDir, preferInt8, hasPreferInt8, modelType, debug ->
      Companion.nativeDetectSttModel(modelDir, preferInt8, hasPreferInt8, modelType, debug)
    },
    NAME
  )
  private val ttsHelper = SherpaOnnxTtsHelper(
    reactApplicationContext,
    { modelDir, modelType -> Companion.nativeDetectTtsModel(modelDir, modelType) },
    { instanceId, samples, sampleRate, progress, isFinal -> emitTtsStreamChunk(instanceId, samples, sampleRate, progress, isFinal) },
    { instanceId, message -> emitTtsStreamError(instanceId, message) },
    { instanceId, cancelled -> emitTtsStreamEnd(instanceId, cancelled) }
  )
  private val archiveHelper = SherpaOnnxArchiveHelper()

  override fun getName(): String {
    return NAME
  }

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    ttsHelper.shutdown()
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
      android.util.Log.e(NAME, "INIT_ERROR: Failed to test sherpa-onnx initialization", e)
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
      emitExtractProgress(sourcePath, bytes, total, percent)
    }
  }

  override fun cancelExtractTarBz2(promise: Promise) {
    archiveHelper.cancelExtractTarBz2()
    promise.resolve(null)
  }

  override fun computeFileSha256(filePath: String, promise: Promise) {
    archiveHelper.computeFileSha256(filePath, promise)
  }

  private fun emitExtractProgress(sourcePath: String, bytes: Long, totalBytes: Long, percent: Double) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("sourcePath", sourcePath)
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
   * Detect STT model type and structure without initializing the recognizer.
   */
  override fun detectSttModel(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = Companion.nativeDetectSttModel(
        modelDir,
        preferInt8 ?: false,
        preferInt8 != null,
        modelType ?: "auto",
        false
      )
      if (result == null) {
        android.util.Log.e(NAME, "DETECT_ERROR: STT model detection returned null")
        promise.reject("DETECT_ERROR", "STT model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", success)
      val modelsArray = Arguments.createArray()
      for (model in detectedModels) {
        val modelMap = model as? HashMap<*, *>
        if (modelMap != null) {
          val entry = Arguments.createMap()
          entry.putString("type", modelMap["type"] as? String ?: "")
          entry.putString("modelDir", modelMap["modelDir"] as? String ?: "")
          modelsArray.pushMap(entry)
        }
      }
      resultMap.putArray("detectedModels", modelsArray)
      if (modelTypeStr != null) {
        resultMap.putString("modelType", modelTypeStr)
      }
      if (!success) {
        val error = result["error"] as? String
        if (!error.isNullOrBlank()) {
          resultMap.putString("error", error)
        }
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "DETECT_ERROR: STT model detection failed: ${e.message}", e)
      promise.reject("DETECT_ERROR", "STT model detection failed: ${e.message}", e)
    }
  }

  /**
   * Initialize Speech-to-Text (STT) with model directory.
   */
  override fun initializeStt(
    instanceId: String,
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    debug: Boolean?,
    hotwordsFile: String?,
    hotwordsScore: Double?,
    numThreads: Double?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Double?,
    modelOptions: ReadableMap?,
    modelingUnit: String?,
    bpeVocab: String?,
    promise: Promise
  ) {
    sttHelper.initializeStt(instanceId, modelDir, preferInt8, modelType, debug, hotwordsFile, hotwordsScore, numThreads, provider, ruleFsts, ruleFars, dither, modelOptions, modelingUnit, bpeVocab, promise)
  }

  /**
   * Release STT resources.
   */
  override fun unloadStt(instanceId: String, promise: Promise) {
    sttHelper.unloadStt(instanceId, promise)
  }

  // ==================== STT Methods ====================

  /**
   * Transcribe an audio file. Returns full result (text, tokens, timestamps, lang, emotion, event, durations).
   */
  override fun transcribeFile(instanceId: String, filePath: String, promise: Promise) {
    sttHelper.transcribeFile(instanceId, filePath, promise)
  }

  /**
   * Transcribe from float PCM samples.
   */
  override fun transcribeSamples(instanceId: String, samples: ReadableArray, sampleRate: Double, promise: Promise) {
    sttHelper.transcribeSamples(instanceId, samples, sampleRate.toInt(), promise)
  }

  /**
   * Update recognizer config at runtime.
   */
  override fun setSttConfig(instanceId: String, options: ReadableMap, promise: Promise) {
    sttHelper.setSttConfig(instanceId, options, promise)
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
        android.util.Log.e(NAME, "CONVERT_ERROR: Invalid outputSampleRateHz: must be >= 0")
        promise.reject("CONVERT_ERROR", "Invalid outputSampleRateHz: must be >= 0")
        return
      }

      if (format.equals("mp3", ignoreCase = true)) {
        val allowed = setOf(0, 32000, 44100, 48000)
        if (!allowed.contains(rate)) {
            android.util.Log.e(NAME, "CONVERT_ERROR: MP3 output sample rate invalid: $rate")
            promise.reject("CONVERT_ERROR", "MP3 output sample rate must be one of 32000, 44100, 48000, or 0 (default). Received: $rate")
          return
        }
      } else {
        rate = rate.coerceIn(0, 48000)
      }

      val err = Companion.nativeConvertAudioToFormat(inputPath, outputPath, format, rate)
      if (err.isEmpty()) {
        promise.resolve(null)
      } else {
        android.util.Log.e(NAME, "CONVERT_ERROR: $err")
        promise.reject("CONVERT_ERROR", err)
      }
    } catch (e: Exception) {
      android.util.Log.e(NAME, "CONVERT_EXCEPTION: Failed to convert audio: ${e.message}", e)
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
            android.util.Log.e(NAME, "CONVERT_ERROR: $err")
            promise.reject("CONVERT_ERROR", err)
      }
    } catch (e: Exception) {
      android.util.Log.e(NAME, "CONVERT_EXCEPTION: Failed to convert audio to WAV16k: ${e.message}", e)
      promise.reject("CONVERT_EXCEPTION", "Failed to convert audio to WAV16k: ${e.message}", e)
    }
  }

  // ==================== TTS Methods ====================

  /**
   * Initialize TTS with model directory.
   */
  override fun initializeTts(
    instanceId: String,
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Double?,
    silenceScale: Double?,
    promise: Promise
  ) {
    ttsHelper.initializeTts(
      instanceId,
      modelDir,
      modelType,
      numThreads,
      debug,
      noiseScale,
      noiseScaleW,
      lengthScale,
      ruleFsts,
      ruleFars,
      maxNumSentences,
      silenceScale,
      promise
    )
  }

  /**
   * Detect TTS model type and structure without initializing the engine.
   */
  override fun detectTtsModel(modelDir: String, modelType: String?, promise: Promise) {
    try {
      val result = Companion.nativeDetectTtsModel(modelDir, modelType ?: "auto")
      if (result == null) {
        android.util.Log.e(NAME, "DETECT_ERROR: TTS model detection returned null")
        promise.reject("DETECT_ERROR", "TTS model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", success)
      val modelsArray = Arguments.createArray()
      for (model in detectedModels) {
        val modelMap = model as? HashMap<*, *>
        if (modelMap != null) {
          val entry = Arguments.createMap()
          entry.putString("type", modelMap["type"] as? String ?: "")
          entry.putString("modelDir", modelMap["modelDir"] as? String ?: "")
          modelsArray.pushMap(entry)
        }
      }
      resultMap.putArray("detectedModels", modelsArray)
      if (modelTypeStr != null) {
        resultMap.putString("modelType", modelTypeStr)
      }
      if (!success) {
        val error = result["error"] as? String
        if (!error.isNullOrBlank()) {
          resultMap.putString("error", error)
        }
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "DETECT_ERROR: TTS model detection failed: ${e.message}", e)
      promise.reject("DETECT_ERROR", "TTS model detection failed: ${e.message}", e)
    }
  }

  /**
   * Update TTS params by re-initializing with stored config.
   */
  override fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    ttsHelper.updateTtsParams(instanceId, noiseScale, noiseScaleW, lengthScale, promise)
  }

  /**
   * Generate speech from text.
   */
  override fun generateTts(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    ttsHelper.generateTts(instanceId, text, options, promise)
  }

  /**
   * Generate speech with subtitle/timestamp metadata.
   */
  override fun generateTtsWithTimestamps(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    ttsHelper.generateTtsWithTimestamps(instanceId, text, options, promise)
  }

  /**
   * Generate speech in streaming mode (emits chunk events).
   */
  override fun generateTtsStream(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    ttsHelper.generateTtsStream(instanceId, text, options, promise)
  }

  /**
   * Cancel ongoing streaming TTS.
   */
  override fun cancelTtsStream(instanceId: String, promise: Promise) {
    ttsHelper.cancelTtsStream(instanceId, promise)
  }

  /**
   * Start PCM playback for streaming TTS.
   */
  override fun startTtsPcmPlayer(instanceId: String, sampleRate: Double, channels: Double, promise: Promise) {
    ttsHelper.startTtsPcmPlayer(instanceId, sampleRate, channels, promise)
  }

  /**
   * Write PCM samples to the streaming TTS player.
   */
  override fun writeTtsPcmChunk(instanceId: String, samples: ReadableArray, promise: Promise) {
    ttsHelper.writeTtsPcmChunk(instanceId, samples, promise)
  }

  /**
   * Stop PCM playback for streaming TTS.
   */
  override fun stopTtsPcmPlayer(instanceId: String, promise: Promise) {
    ttsHelper.stopTtsPcmPlayer(instanceId, promise)
  }

  private fun emitTtsStreamChunk(
    instanceId: String,
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
    payload.putString("instanceId", instanceId)
    payload.putArray("samples", samplesArray)
    payload.putInt("sampleRate", sampleRate)
    payload.putDouble("progress", progress.toDouble())
    payload.putBoolean("isFinal", isFinal)
    eventEmitter.emit("ttsStreamChunk", payload)
  }

  private fun emitTtsStreamError(instanceId: String, message: String) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putString("message", message)
    eventEmitter.emit("ttsStreamError", payload)
  }

  private fun emitTtsStreamEnd(instanceId: String, cancelled: Boolean) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putBoolean("cancelled", cancelled)
    eventEmitter.emit("ttsStreamEnd", payload)
  }

  /**
   * Get TTS sample rate.
   */
  override fun getTtsSampleRate(instanceId: String, promise: Promise) {
    ttsHelper.getTtsSampleRate(instanceId, promise)
  }

  /**
   * Get number of speakers.
   */
  override fun getTtsNumSpeakers(instanceId: String, promise: Promise) {
    ttsHelper.getTtsNumSpeakers(instanceId, promise)
  }

  /**
   * Release TTS resources.
   */
  override fun unloadTts(instanceId: String, promise: Promise) {
    ttsHelper.unloadTts(instanceId, promise)
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
