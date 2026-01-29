package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

@ReactModule(name = SherpaOnnxModule.NAME)
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
  NativeSherpaOnnxSpec(reactContext) {

  init {
    System.loadLibrary("sherpaonnx")
  }

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
    promise: Promise
  ) {
    try {
      val result = nativeTtsInitialize(
        modelDir,
        modelType,
        numThreads.toInt(),
        debug
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
        promise.resolve(resultMap)
      } else {
        promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS")
      }
    } catch (e: Exception) {
      promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS", e)
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
      nativeTtsRelease()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_RELEASE_ERROR", "Failed to release TTS resources", e)
    }
  }

  companion object {
    const val NAME = "SherpaOnnx"

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
      debug: Boolean
    ): java.util.HashMap<String, Any>?

    @JvmStatic
    private external fun nativeTtsGenerate(
      text: String,
      sid: Int,
      speed: Float
    ): java.util.HashMap<String, Any>?

    @JvmStatic
    private external fun nativeTtsGetSampleRate(): Int

    @JvmStatic
    private external fun nativeTtsGetNumSpeakers(): Int

    @JvmStatic
    private external fun nativeTtsRelease()
  }
}
