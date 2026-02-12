package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import java.io.File

internal class SherpaOnnxSttHelper(
  private val native: NativeSttBridge,
  private val logTag: String
) {
  interface NativeSttBridge {
    fun nativeSttInitialize(
      modelDir: String,
      preferInt8: Boolean,
      hasPreferInt8: Boolean,
      modelType: String
    ): HashMap<String, Any>?

    fun nativeSttTranscribe(filePath: String): String

    fun nativeSttRelease()
  }

  fun initializeSherpaOnnx(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        val errorMsg = "Model directory does not exist: $modelDir"
        Log.e(logTag, errorMsg)
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      if (!modelDirFile.isDirectory) {
        val errorMsg = "Model path is not a directory: $modelDir"
        Log.e(logTag, errorMsg)
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      val result = native.nativeSttInitialize(
        modelDir,
        preferInt8 ?: false,
        preferInt8 != null,
        modelType ?: "auto"
      )

      if (result == null) {
        val errorMsg = "Failed to initialize sherpa-onnx. Check native logs for details."
        Log.e(logTag, "Native initialization returned null for modelDir: $modelDir")
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()

      if (success) {
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
        val reason = result["error"] as? String
        val errorMsg = if (!reason.isNullOrBlank()) {
          "Failed to initialize sherpa-onnx: $reason"
        } else {
          "Failed to initialize sherpa-onnx. Check native logs for details."
        }
        Log.e(logTag, "Native initialization returned false for modelDir: $modelDir")
        promise.reject("INIT_ERROR", errorMsg)
      }
    } catch (e: Exception) {
      val errorMsg = "Exception during initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMsg, e)
      promise.reject("INIT_ERROR", errorMsg, e)
    }
  }

  fun transcribeFile(filePath: String, promise: Promise) {
    try {
      val result = native.nativeSttTranscribe(filePath)
      promise.resolve(result)
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe file"
      Log.e(logTag, "transcribeFile error: $message", e)
      promise.reject("TRANSCRIBE_ERROR", message, e)
    }
  }

  fun unloadSherpaOnnx(promise: Promise) {
    try {
      native.nativeSttRelease()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("RELEASE_ERROR", "Failed to release resources", e)
    }
  }
}
