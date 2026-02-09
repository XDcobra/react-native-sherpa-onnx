package com.sherpaonnx

import android.util.Log
import android.net.Uri
import android.provider.DocumentsContract
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.AudioManager
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean

@ReactModule(name = SherpaOnnxModule.NAME)
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
  NativeSherpaOnnxSpec(reactContext) {

  init {
    System.loadLibrary("sherpaonnx")
    instance = this
  }

  private val ttsStreamRunning = AtomicBoolean(false)
  private val ttsStreamCancelled = AtomicBoolean(false)
  private var ttsStreamThread: Thread? = null
  private var ttsPcmTrack: AudioTrack? = null

  private data class TtsInitState(
    val modelDir: String,
    val modelType: String,
    val numThreads: Int,
    val debug: Boolean,
    val noiseScale: Double?,
    val lengthScale: Double?
  )

  private var ttsInitState: TtsInitState? = null

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
    try {
      val type = config.getString("type") ?: "auto"
      val path = config.getString("path")
        ?: throw IllegalArgumentException("Path is required")

      val resolvedPath = when (type) {
        "asset" -> resolveAssetPath(path)
        "file" -> resolveFilePath(path)
        "auto" -> resolveAutoPath(path)
        else -> throw IllegalArgumentException("Unknown path type: $type")
      }

      promise.resolve(resolvedPath)
    } catch (e: Exception) {
      val errorMessage = "Failed to resolve model path: ${e.message ?: e.javaClass.simpleName}"
      Log.e(NAME, errorMessage, e)
      promise.reject("PATH_RESOLVE_ERROR", errorMessage, e)
    }
  }

  /**
   * Resolve asset path - copy from assets to internal storage if needed
   * Preserves the directory structure from assets (e.g., test_wavs/ stays as test_wavs/)
   */
  private fun resolveAssetPath(assetPath: String): String {
    val assetManager = reactApplicationContext.assets
    
    // Extract base directory from path (e.g., "test_wavs/en-1.wav" -> "test_wavs", "models/sherpa-onnx-model" -> "models")
    val pathParts = assetPath.split("/")
    val baseDir = if (pathParts.size > 1) pathParts[0] else "models"
    
    val targetBaseDir = File(reactApplicationContext.filesDir, baseDir)
    targetBaseDir.mkdirs()

    // Check if it's a file path (contains a file extension) or directory path
    val isFilePath = pathParts.any { it.contains(".") && !it.startsWith(".") }
    
    val targetPath = if (isFilePath) {
      // It's a file path (e.g., test_wavs/en-1.wav)
      // Return the full file path
      File(targetBaseDir, pathParts.drop(1).joinToString("/"))
    } else {
      // It's a directory path (e.g., models/sherpa-onnx-model)
      // Return the directory path
      File(targetBaseDir, File(assetPath).name)
    }
    
    // Check if already extracted
    if (isFilePath) {
      // For files, check if file exists
      if (targetPath.exists() && targetPath.isFile) {
        return targetPath.absolutePath
      }
      // Extract the parent directory (e.g., test_wavs/)
      val parentDir = targetPath.parentFile ?: targetBaseDir
      parentDir.mkdirs()
      
      // Try to copy the file directly first
      try {
        assetManager.open(assetPath).use { input ->
          FileOutputStream(targetPath).use { output ->
            input.copyTo(output)
          }
        }
        return targetPath.absolutePath
      } catch (e: java.io.FileNotFoundException) {
        // If direct file open fails, try to copy the parent directory recursively
        // This handles cases where the file is in a subdirectory
        val parentAssetPath = pathParts.dropLast(1).joinToString("/")
        if (parentAssetPath.isNotEmpty()) {
          try {
            // Copy the entire parent directory
            copyAssetRecursively(assetManager, parentAssetPath, parentDir)
            // Check if file now exists
            if (targetPath.exists() && targetPath.isFile) {
              return targetPath.absolutePath
            }
            throw IllegalArgumentException("File not found after copying parent directory: $assetPath")
          } catch (dirException: Exception) {
            throw IllegalArgumentException("Failed to extract asset file: $assetPath. Tried direct copy and directory copy.", dirException)
          }
        } else {
          throw IllegalArgumentException("Failed to extract asset file: $assetPath", e)
        }
      } catch (e: Exception) {
        throw IllegalArgumentException("Failed to extract asset file: $assetPath", e)
      }
    } else {
      // For directories, check if directory exists
      if (targetPath.exists() && targetPath.isDirectory) {
        return targetPath.absolutePath
      }
      // Extract from assets recursively
      try {
        targetPath.mkdirs()
        copyAssetRecursively(assetManager, assetPath, targetPath)
        return targetPath.absolutePath
      } catch (e: Exception) {
        throw IllegalArgumentException("Failed to extract asset directory: $assetPath", e)
      }
    }
  }

  /**
   * Recursively copy assets from asset manager to target directory
   */
  private fun copyAssetRecursively(
    assetManager: android.content.res.AssetManager,
    assetPath: String,
    targetDir: File
  ) {
    val assetFiles = assetManager.list(assetPath)
      ?: throw IllegalArgumentException("Asset path not found: $assetPath")

    for (fileName in assetFiles) {
      val assetFilePath = "$assetPath/$fileName"
      val targetFile = File(targetDir, fileName)

      try {
        // Try to list as directory first
        val subFiles = assetManager.list(assetFilePath)
        if (subFiles != null && subFiles.isNotEmpty()) {
          // It's a directory, recurse
          targetFile.mkdirs()
          copyAssetRecursively(assetManager, assetFilePath, targetFile)
        } else {
          // It's a file, copy it
          assetManager.open(assetFilePath).use { input ->
            FileOutputStream(targetFile).use { output ->
              input.copyTo(output)
            }
          }
        }
      } catch (e: Exception) {
        // If listing fails, try to open as file
        try {
          assetManager.open(assetFilePath).use { input ->
            FileOutputStream(targetFile).use { output ->
              input.copyTo(output)
            }
          }
        } catch (fileException: Exception) {
          throw IllegalArgumentException("Failed to copy asset: $assetFilePath", fileException)
        }
      }
    }
  }

  /**
   * Resolve file system path - verify it exists
   */
  private fun resolveFilePath(filePath: String): String {
    val file = File(filePath)
    if (!file.exists()) {
      throw IllegalArgumentException("File path does not exist: $filePath")
    }
    if (!file.isDirectory) {
      throw IllegalArgumentException("Path is not a directory: $filePath")
    }
    return file.absolutePath
  }

  /**
   * Auto-detect path - try asset first, then file system
   */
  private fun resolveAutoPath(path: String): String {
    return try {
      resolveAssetPath(path)
    } catch (e: Exception) {
      // If asset fails, try file system
      try {
        resolveFilePath(path)
      } catch (fileException: Exception) {
        throw IllegalArgumentException(
          "Path not found as asset or file: $path. Asset error: ${e.message}, File error: ${fileException.message}",
          e
        )
      }
    }
  }

  /**
   * Initialize sherpa-onnx with model directory.
   * Phase 1: Stub implementation
   */
  override fun initializeSherpaOnnx(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      // Verify model directory exists
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        val errorMsg = "Model directory does not exist: $modelDir"
        Log.e(NAME, errorMsg)
        promise.reject("INIT_ERROR", errorMsg)
        return
      }
      
      if (!modelDirFile.isDirectory) {
        val errorMsg = "Model path is not a directory: $modelDir"
        Log.e(NAME, errorMsg)
        promise.reject("INIT_ERROR", errorMsg)
        return
      }
      
      val result = nativeSttInitialize(
        modelDir,
        preferInt8 ?: false,
        preferInt8 != null,
        modelType ?: "auto"
      )
      
      if (result == null) {
        val errorMsg = "Failed to initialize sherpa-onnx. Check native logs for details."
        Log.e(NAME, "Native initialization returned null for modelDir: $modelDir")
        promise.reject("INIT_ERROR", errorMsg)
        return
      }
      
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*> ?: arrayListOf<HashMap<String, String>>()
      
      if (success) {
        // Create result map with detected models
        val resultMap = Arguments.createMap()
        resultMap.putBoolean("success", true)
        val detectedModelsArray = Arguments.createArray()
        for (model in detectedModels) {
          val modelMap = model as? HashMap<*, *>
          if (modelMap != null) {
            val modelResultMap = Arguments.createMap()
            modelResultMap.putString("type", modelMap["type"] as? String ?: "")
            modelResultMap.putString("modelDir", modelMap["modelDir"] as? String ?: "")
            detectedModelsArray.pushMap(modelResultMap)
          }
        }
        resultMap.putArray("detectedModels", detectedModelsArray)
        promise.resolve(resultMap)
      } else {
        val errorMsg = "Failed to initialize sherpa-onnx. Check native logs for details."
        Log.e(NAME, "Native initialization returned false for modelDir: $modelDir")
        promise.reject("INIT_ERROR", errorMsg)
      }
    } catch (e: Exception) {
      val errorMsg = "Exception during initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(NAME, errorMsg, e)
      promise.reject("INIT_ERROR", errorMsg, e)
    }
  }

  /**
   * Transcribe an audio file.
   * Phase 1: Stub implementation
   */
  override fun transcribeFile(filePath: String, promise: Promise) {
    try {
      val result = nativeSttTranscribe(filePath)
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("TRANSCRIBE_ERROR", "Failed to transcribe file", e)
    }
  }

  /**
   * Release sherpa-onnx resources.
   */
  override fun unloadSherpaOnnx(promise: Promise) {
    try {
      nativeSttRelease()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("RELEASE_ERROR", "Failed to release resources", e)
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
    lengthScale: Double?,
    promise: Promise
  ) {
    try {
      val result = nativeTtsInitialize(
        modelDir,
        modelType,
        numThreads.toInt(),
        debug,
        noiseScale ?: Double.NaN,
        lengthScale ?: Double.NaN
      )
      
      if (result == null) {
        promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS: native call returned null")
        return
      }
      
      val success = result["success"] as? Boolean ?: false
      
      if (success) {
        // Extract detected models from result
        val detectedModels = result["detectedModels"] as? ArrayList<*>
        val modelsArray = Arguments.createArray()
        
        detectedModels?.forEach { modelObj ->
          if (modelObj is HashMap<*, *>) {
            val modelMap = Arguments.createMap()
            modelMap.putString("type", modelObj["type"] as? String ?: "")
            modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
            modelsArray.pushMap(modelMap)
          }
        }
        
        // Create result map with success and detectedModels
        val resultMap = Arguments.createMap()
        resultMap.putBoolean("success", true)
        resultMap.putArray("detectedModels", modelsArray)
        ttsInitState = TtsInitState(
          modelDir,
          modelType,
          numThreads.toInt(),
          debug,
          noiseScale?.takeUnless { it.isNaN() },
          lengthScale?.takeUnless { it.isNaN() }
        )
        promise.resolve(resultMap)
      } else {
        promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS")
      }
    } catch (e: Exception) {
      promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS", e)
    }
  }

  /**
   * Update TTS params by re-initializing with stored config.
   */
  override fun updateTtsParams(
    noiseScale: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    if (ttsStreamRunning.get()) {
      promise.reject("TTS_UPDATE_ERROR", "Cannot update params while streaming")
      return
    }

    val state = ttsInitState
    if (state == null) {
      promise.reject("TTS_UPDATE_ERROR", "TTS not initialized")
      return
    }

    val nextNoiseScale = when {
      noiseScale == null -> null
      noiseScale.isNaN() -> state.noiseScale
      else -> noiseScale
    }
    val nextLengthScale = when {
      lengthScale == null -> null
      lengthScale.isNaN() -> state.lengthScale
      else -> lengthScale
    }

    try {
      val result = nativeTtsInitialize(
        state.modelDir,
        state.modelType,
        state.numThreads,
        state.debug,
        nextNoiseScale ?: Double.NaN,
        nextLengthScale ?: Double.NaN
      )

      if (result == null) {
        promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params: native call returned null")
        return
      }

      val success = result["success"] as? Boolean ?: false
      if (!success) {
        promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params")
        return
      }

      val detectedModels = result["detectedModels"] as? ArrayList<*>
      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putArray("detectedModels", modelsArray)
      ttsInitState = TtsInitState(
        state.modelDir,
        state.modelType,
        state.numThreads,
        state.debug,
        nextNoiseScale,
        nextLengthScale
      )
      promise.resolve(resultMap)
    } catch (e: Exception) {
      promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params", e)
    }
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
    try {
      val result = nativeTtsGenerate(text, sid.toInt(), speed.toFloat())
      if (result != null) {
        // Convert HashMap to WritableMap for React Native
        val map = com.facebook.react.bridge.Arguments.createMap()
        
        @Suppress("UNCHECKED_CAST")
        val samples = result["samples"] as? FloatArray
        val sampleRate = result["sampleRate"] as? Int
        
        if (samples != null && sampleRate != null) {
          // Convert FloatArray to WritableArray
          val samplesArray = com.facebook.react.bridge.Arguments.createArray()
          for (sample in samples) {
            samplesArray.pushDouble(sample.toDouble())
          }
          
          map.putArray("samples", samplesArray)
          map.putInt("sampleRate", sampleRate)
          promise.resolve(map)
        } else {
          promise.reject("TTS_GENERATE_ERROR", "Invalid result format from native code")
        }
      } else {
        promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech")
      }
    } catch (e: Exception) {
      promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech", e)
    }
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
    try {
      val result = nativeTtsGenerateWithTimestamps(text, sid.toInt(), speed.toFloat())
      if (result != null) {
        val map = Arguments.createMap()

        @Suppress("UNCHECKED_CAST")
        val samples = result["samples"] as? FloatArray
        val sampleRate = result["sampleRate"] as? Int
        val subtitles = result["subtitles"] as? ArrayList<*>
        val estimated = result["estimated"] as? Boolean ?: true

        if (samples != null && sampleRate != null) {
          val samplesArray = Arguments.createArray()
          for (sample in samples) {
            samplesArray.pushDouble(sample.toDouble())
          }

          val subtitlesArray = Arguments.createArray()
          subtitles?.forEach { item ->
            if (item is HashMap<*, *>) {
              val subtitleMap = Arguments.createMap()
              subtitleMap.putString("text", item["text"] as? String ?: "")
              subtitleMap.putDouble("start", (item["start"] as? Number)?.toDouble() ?: 0.0)
              subtitleMap.putDouble("end", (item["end"] as? Number)?.toDouble() ?: 0.0)
              subtitlesArray.pushMap(subtitleMap)
            }
          }

          map.putArray("samples", samplesArray)
          map.putInt("sampleRate", sampleRate)
          map.putArray("subtitles", subtitlesArray)
          map.putBoolean("estimated", estimated)
          promise.resolve(map)
        } else {
          promise.reject("TTS_GENERATE_ERROR", "Invalid result format from native code")
        }
      } else {
        promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech")
      }
    } catch (e: Exception) {
      promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech", e)
    }
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
    if (ttsStreamRunning.get()) {
      promise.reject("TTS_STREAM_ERROR", "TTS streaming already in progress")
      return
    }

    ttsStreamCancelled.set(false)
    ttsStreamRunning.set(true)

    ttsStreamThread = Thread {
      var success = false
      try {
        success = nativeTtsGenerateStream(text, sid.toInt(), speed.toFloat())
        if (!success && !ttsStreamCancelled.get()) {
          emitTtsStreamError("TTS streaming generation failed")
        }
      } catch (e: Exception) {
        emitTtsStreamError("TTS streaming failed: ${e.message}")
      } finally {
        emitTtsStreamEnd(ttsStreamCancelled.get())
        ttsStreamRunning.set(false)
      }
    }

    ttsStreamThread?.start()
    promise.resolve(null)
  }

  /**
   * Cancel ongoing streaming TTS.
   */
  override fun cancelTtsStream(promise: Promise) {
    ttsStreamCancelled.set(true)
    try {
      nativeTtsCancelStream()
      ttsStreamThread?.interrupt()
    } catch (e: Exception) {
      promise.reject("TTS_STREAM_ERROR", "Failed to cancel TTS stream", e)
      return
    }
    promise.resolve(null)
  }

  /**
   * Start PCM playback for streaming TTS.
   */
  override fun startTtsPcmPlayer(sampleRate: Double, channels: Double, promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        promise.reject("TTS_PCM_ERROR", "PCM playback requires API 21+")
        return
      }

      if (channels.toInt() != 1) {
        promise.reject("TTS_PCM_ERROR", "PCM playback supports mono only")
        return
      }

      stopPcmPlayerInternal()

      val channelConfig = AudioFormat.CHANNEL_OUT_MONO

      val audioFormat = AudioFormat.Builder()
        .setSampleRate(sampleRate.toInt())
        .setChannelMask(channelConfig)
        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .build()

      val minBufferSize = AudioTrack.getMinBufferSize(
        sampleRate.toInt(),
        channelConfig,
        AudioFormat.ENCODING_PCM_FLOAT
      )

      if (minBufferSize == AudioTrack.ERROR || minBufferSize == AudioTrack.ERROR_BAD_VALUE) {
        promise.reject("TTS_PCM_ERROR", "Invalid buffer size for PCM player")
        return
      }

      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

      ttsPcmTrack = AudioTrack(
        attributes,
        audioFormat,
        minBufferSize,
        AudioTrack.MODE_STREAM,
        AudioManager.AUDIO_SESSION_ID_GENERATE
      )

      ttsPcmTrack?.play()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_PCM_ERROR", "Failed to start PCM player", e)
    }
  }

  /**
   * Write PCM samples to the streaming TTS player.
   */
  override fun writeTtsPcmChunk(samples: ReadableArray, promise: Promise) {
    val track = ttsPcmTrack
    if (track == null) {
      promise.reject("TTS_PCM_ERROR", "PCM player not initialized")
      return
    }

    try {
      val buffer = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        buffer[i] = samples.getDouble(i).toFloat()
      }

      val written = track.write(buffer, 0, buffer.size, AudioTrack.WRITE_BLOCKING)
      if (written < 0) {
        promise.reject("TTS_PCM_ERROR", "PCM write failed: $written")
        return
      }

      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_PCM_ERROR", "Failed to write PCM chunk", e)
    }
  }

  /**
   * Stop PCM playback for streaming TTS.
   */
  override fun stopTtsPcmPlayer(promise: Promise) {
    try {
      stopPcmPlayerInternal()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_PCM_ERROR", "Failed to stop PCM player", e)
    }
  }

  private fun stopPcmPlayerInternal() {
    ttsPcmTrack?.apply {
      try {
        stop()
      } catch (_: IllegalStateException) {
      }
      flush()
      release()
    }
    ttsPcmTrack = null
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
    try {
      val sampleRate = nativeTtsGetSampleRate()
      promise.resolve(sampleRate.toDouble())
    } catch (e: Exception) {
      promise.reject("TTS_ERROR", "Failed to get sample rate", e)
    }
  }

  /**
   * Get number of speakers.
   */
  override fun getTtsNumSpeakers(promise: Promise) {
    try {
      val numSpeakers = nativeTtsGetNumSpeakers()
      promise.resolve(numSpeakers.toDouble())
    } catch (e: Exception) {
      promise.reject("TTS_ERROR", "Failed to get number of speakers", e)
    }
  }

  /**
   * Release TTS resources.
   */
  override fun unloadTts(promise: Promise) {
    try {
      stopPcmPlayerInternal()
      nativeTtsRelease()
      ttsInitState = null
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_RELEASE_ERROR", "Failed to release TTS resources", e)
    }
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
    try {
      // Convert ReadableArray to FloatArray
      val samplesArray = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        samplesArray[i] = samples.getDouble(i).toFloat()
      }
      
      val success = nativeTtsSaveToWavFile(samplesArray, sampleRate.toInt(), filePath)
      if (success) {
        promise.resolve(filePath)
      } else {
        promise.reject("TTS_SAVE_ERROR", "Failed to save audio to file")
      }
    } catch (e: Exception) {
      promise.reject("TTS_SAVE_ERROR", "Failed to save audio to file", e)
    }
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
    try {
      val samplesArray = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        samplesArray[i] = samples.getDouble(i).toFloat()
      }

      val resolver = reactApplicationContext.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = createDocumentInDirectory(resolver, dirUri, filename, "audio/wav")

      resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
        writeWavToStream(samplesArray, sampleRate.toInt(), outputStream)
      } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")

      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      promise.reject("TTS_SAVE_ERROR", "Failed to save audio to content URI", e)
    }
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
    try {
      val resolver = reactApplicationContext.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = createDocumentInDirectory(resolver, dirUri, filename, mimeType)

      resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
        outputStream.write(text.toByteArray(Charsets.UTF_8))
      } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")

      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      promise.reject("TTS_SAVE_ERROR", "Failed to save text to content URI", e)
    }
  }

  /**
   * Copy a SAF content URI to a cache file for local playback.
   */
  override fun copyTtsContentUriToCache(
    fileUri: String,
    filename: String,
    promise: Promise
  ) {
    try {
      val resolver = reactApplicationContext.contentResolver
      val uri = Uri.parse(fileUri)
      val cacheFile = File(reactApplicationContext.cacheDir, filename)

      resolver.openInputStream(uri)?.use { inputStream ->
        FileOutputStream(cacheFile).use { outputStream ->
          copyStream(inputStream, outputStream)
        }
      } ?: throw IllegalStateException("Failed to open input stream for URI: $fileUri")

      promise.resolve(cacheFile.absolutePath)
    } catch (e: Exception) {
      promise.reject("TTS_SAVE_ERROR", "Failed to copy audio to cache", e)
    }
  }

  /**
   * Share a TTS audio file (file path or content URI).
   */
  override fun shareTtsAudio(fileUri: String, mimeType: String, promise: Promise) {
    try {
      val context = reactApplicationContext
      val uri = if (fileUri.startsWith("content://")) {
        Uri.parse(fileUri)
      } else {
        // Handle file:// URIs by stripping scheme
        val path = if (fileUri.startsWith("file://")) {
          try {
            Uri.parse(fileUri).path ?: fileUri.replaceFirst("file://", "")
          } catch (e: Exception) {
            fileUri.replaceFirst("file://", "")
          }
        } else {
          fileUri
        }

        val file = File(path)
        val authority = context.packageName + ".fileprovider"
        FileProvider.getUriForFile(context, authority, file)
      }

      val shareIntent = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      val chooser = Intent.createChooser(shareIntent, "Share audio")
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_SHARE_ERROR", "Failed to share audio", e)
    }
  }

  /**
   * List all model folders in the assets/models directory.
   * Scans the platform-specific model directory and returns folder names.
   */
  override fun listAssetModels(promise: Promise) {
    try {
      val assetManager = reactApplicationContext.assets
      val modelFolders = mutableListOf<String>()
      
      try {
        // List all items in the "models" directory
        val items = assetManager.list("models") ?: emptyArray()
        
        // Filter to only include directories (check if they have contents)
        for (item in items) {
          val subItems = assetManager.list("models/$item")
          if (subItems != null && subItems.isNotEmpty()) {
            // It's a directory with contents
            modelFolders.add(item)
          }
        }
      } catch (e: Exception) {
        Log.w(NAME, "Could not list models directory: ${e.message}")
        // Return empty list if models directory doesn't exist
      }
      
      val result = Arguments.createArray()
      modelFolders.forEach { folder ->
        val modelMap = Arguments.createMap()
        modelMap.putString("folder", folder)
        modelMap.putString("hint", inferModelHint(folder))
        result.pushMap(modelMap)
      }
      
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("LIST_ASSETS_ERROR", "Failed to list asset models: ${e.message}", e)
    }
  }

  /**
   * Infer a high-level model type hint from a folder name.
   */
  private fun inferModelHint(folderName: String): String {
    val name = folderName.lowercase()
    val sttHints = listOf(
      "zipformer",
      "paraformer",
      "nemo",
      "parakeet",
      "whisper",
      "wenet",
      "sensevoice",
      "sense-voice",
      "sense",
      "funasr",
      "transducer",
      "ctc",
      "asr"
    )
    val ttsHints = listOf(
      "vits",
      "piper",
      "matcha",
      "kokoro",
      "kitten",
      "zipvoice",
      "melo",
      "coqui",
      "mms",
      "tts"
    )

    val isStt = sttHints.any { name.contains(it) }
    val isTts = ttsHints.any { name.contains(it) }

    return when {
      isStt && !isTts -> "stt"
      isTts && !isStt -> "tts"
      else -> "unknown"
    }
  }

  private fun createDocumentInDirectory(
    resolver: android.content.ContentResolver,
    directoryUri: Uri,
    filename: String,
    mimeType: String
  ): Uri {
    return if (DocumentsContract.isTreeUri(directoryUri)) {
      val documentId = DocumentsContract.getTreeDocumentId(directoryUri)
      val dirDocUri = DocumentsContract.buildDocumentUriUsingTree(directoryUri, documentId)
      DocumentsContract.createDocument(resolver, dirDocUri, mimeType, filename)
        ?: throw IllegalStateException("Failed to create document in tree URI")
    } else {
      DocumentsContract.createDocument(resolver, directoryUri, mimeType, filename)
        ?: throw IllegalStateException("Failed to create document in directory URI")
    }
  }

  private fun writeWavToStream(samples: FloatArray, sampleRate: Int, outputStream: OutputStream) {
    val numChannels = 1
    val bitsPerSample = 16
    val byteRate = sampleRate * numChannels * bitsPerSample / 8
    val blockAlign = numChannels * bitsPerSample / 8
    val dataSize = samples.size * 2
    val chunkSize = 36 + dataSize

    outputStream.write("RIFF".toByteArray(Charsets.US_ASCII))
    writeIntLE(outputStream, chunkSize)
    outputStream.write("WAVE".toByteArray(Charsets.US_ASCII))
    outputStream.write("fmt ".toByteArray(Charsets.US_ASCII))
    writeIntLE(outputStream, 16)
    writeShortLE(outputStream, 1)
    writeShortLE(outputStream, numChannels.toShort())
    writeIntLE(outputStream, sampleRate)
    writeIntLE(outputStream, byteRate)
    writeShortLE(outputStream, blockAlign.toShort())
    writeShortLE(outputStream, bitsPerSample.toShort())
    outputStream.write("data".toByteArray(Charsets.US_ASCII))
    writeIntLE(outputStream, dataSize)

    for (sample in samples) {
      val clamped = sample.coerceIn(-1.0f, 1.0f)
      val intSample = (clamped * 32767.0f).toInt()
      writeShortLE(outputStream, intSample.toShort())
    }

    outputStream.flush()
  }

  private fun writeIntLE(outputStream: OutputStream, value: Int) {
    outputStream.write(value and 0xFF)
    outputStream.write((value shr 8) and 0xFF)
    outputStream.write((value shr 16) and 0xFF)
    outputStream.write((value shr 24) and 0xFF)
  }

  private fun writeShortLE(outputStream: OutputStream, value: Short) {
    val intValue = value.toInt()
    outputStream.write(intValue and 0xFF)
    outputStream.write((intValue shr 8) and 0xFF)
  }

  private fun copyStream(inputStream: InputStream, outputStream: OutputStream) {
    val buffer = ByteArray(8192)
    var bytes = inputStream.read(buffer)
    while (bytes >= 0) {
      outputStream.write(buffer, 0, bytes)
      bytes = inputStream.read(buffer)
    }
    outputStream.flush()
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
