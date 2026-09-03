package com.sherpaonnx.diarization.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap

internal class SherpaOnnxDiarizationHelper(
  private val nativeDetectDiarizationModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?,
) {
  fun detectDiarizationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise,
  ) {
    try {
      val result =
        nativeDetectDiarizationModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject(DETECT_ERROR, "Diarization model detection returned null")
        return
      }
      promise.resolve(detectResultToWritable(result))
    } catch (e: Exception) {
      Log.e(TAG, "Diarization detection failed", e)
      promise.reject(
        DETECT_ERROR,
        "Diarization model detection failed: ${e.message}",
        e,
      )
    }
  }

  private fun detectResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    map.putBoolean("isStreaming", result["isStreaming"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val mt = result["modelType"] as? String
    if (!mt.isNullOrBlank()) map.putString("modelType", mt)

    val models = Arguments.createArray()
    @Suppress("UNCHECKED_CAST")
    val detected = result["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
    for (entry in detected) {
      val m = Arguments.createMap()
      m.putString("type", entry["type"] ?: "")
      m.putString("modelDir", entry["modelDir"] ?: "")
      models.pushMap(m)
    }
    map.putArray("detectedModels", models)

    val languages = result["languages"] as? ArrayList<*>
    if (!languages.isNullOrEmpty()) {
      val arr = Arguments.createArray()
      for (entry in languages) {
        val value = entry as? String
        if (!value.isNullOrBlank()) arr.pushString(value)
      }
      if (arr.size() > 0) map.putArray("languages", arr)
    }

    val quantization = result["quantization"] as? String
    if (!quantization.isNullOrBlank()) map.putString("quantization", quantization)

    val detectionSources = result["detectionSources"] as? ArrayList<*>
    if (!detectionSources.isNullOrEmpty()) {
      val arr = Arguments.createArray()
      for (entry in detectionSources) {
        val value = entry as? String
        if (!value.isNullOrBlank()) arr.pushString(value)
      }
      if (arr.size() > 0) map.putArray("detectionSources", arr)
    }

    @Suppress("UNCHECKED_CAST")
    val paths = result["paths"] as? HashMap<String, Any?>
    if (paths != null) {
      val writablePaths = Arguments.createMap()
      val modelPath = paths["model"] as? String
      if (!modelPath.isNullOrBlank()) writablePaths.putString("model", modelPath)
      if (writablePaths.toHashMap().isNotEmpty()) {
        map.putMap("paths", writablePaths)
      }
    }

    return map
  }

  companion object {
    private const val TAG = "SherpaOnnxDiarization"
    private const val DETECT_ERROR = "DIARIZATION_DETECT_ERROR"
  }
}
