package com.sherpaonnx.punctuation.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
class SherpaOnnxPunctuationHelper(
  private val nativeDetectPunctuationModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String
  ) -> HashMap<String, Any>?
) {
  fun detectPunctuationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectPunctuationModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject("PUNCT_DETECT_ERROR", "Punctuation model detection returned null")
        return
      }
      val map = Arguments.createMap()
      map.putBoolean("success", result["success"] as? Boolean ?: false)
      val error = result["error"] as? String
      if (!error.isNullOrBlank()) map.putString("error", error)
      val mt = result["modelType"] as? String
      if (!mt.isNullOrBlank()) map.putString("modelType", mt)
      map.putBoolean("isStreaming", result["isStreaming"] as? Boolean ?: false)
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
        map.putArray("languages", arr)
      }
      val q = result["quantization"] as? String
      if (!q.isNullOrBlank()) map.putString("quantization", q)
      val detSrc = result["detectionSources"] as? ArrayList<*>
      if (!detSrc.isNullOrEmpty()) {
        val arr = Arguments.createArray()
        for (e in detSrc) {
          val s = e as? String
          if (!s.isNullOrBlank()) arr.pushString(s)
        }
        map.putArray("detectionSources", arr)
      }
      @Suppress("UNCHECKED_CAST")
      val paths = result["paths"] as? HashMap<*, *>
      if (paths != null) {
        val pm = Arguments.createMap()
        var any = false
        (paths["ct_transformer"] as? String)?.takeIf { it.isNotEmpty() }?.let {
          pm.putString("ct_transformer", it)
          any = true
        }
        (paths["cnn_bilstm"] as? String)?.takeIf { it.isNotEmpty() }?.let {
          pm.putString("cnn_bilstm", it)
          any = true
        }
        (paths["bpe_vocab"] as? String)?.takeIf { it.isNotEmpty() }?.let {
          pm.putString("bpe_vocab", it)
          any = true
        }
        if (any) {
          map.putMap("paths", pm)
        }
      }
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "Punctuation detection failed", e)
      promise.reject(
        "PUNCT_DETECT_ERROR",
        "Punctuation model detection failed: ${e.message}",
        e
      )
    }
  }
}
