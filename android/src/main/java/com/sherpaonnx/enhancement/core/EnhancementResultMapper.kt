package com.sherpaonnx.enhancement.core

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

internal object EnhancementResultMapper {
  fun detectResultToWritable(result: HashMap<String, Any>): WritableMap {
    val success = result["success"] as? Boolean ?: false
    val detectedModels = result["detectedModels"] as? ArrayList<*>
    val modelType = result["modelType"] as? String
    val detectionSources = result["detectionSources"] as? ArrayList<*>
    val languages = result["languages"] as? ArrayList<*>
    val quantization = result["quantization"] as? String
    val error = result["error"] as? String

    return Arguments.createMap().apply {
      putBoolean("success", success)
      putArray("detectedModels", detectedModelsToWritableArray(detectedModels))
      if (!modelType.isNullOrBlank()) {
        putString("modelType", modelType)
      }
      if (!error.isNullOrBlank()) {
        putString("error", error)
      }
      if (!quantization.isNullOrBlank()) {
        putString("quantization", quantization)
      }

      detectionSources
        ?.mapNotNull { it as? String }
        ?.filter { it.isNotBlank() }
        ?.takeIf { it.isNotEmpty() }
        ?.let {
          val arr = Arguments.createArray()
          it.forEach(arr::pushString)
          putArray("detectionSources", arr)
        }

      languages
        ?.mapNotNull { it as? String }
        ?.filter { it.isNotBlank() }
        ?.takeIf { it.isNotEmpty() }
        ?.let {
          val arr = Arguments.createArray()
          it.forEach(arr::pushString)
          putArray("languages", arr)
        }
    }
  }

  fun detectedModelsToWritableArray(detectedModels: ArrayList<*>?): WritableArray {
    val modelsArray = Arguments.createArray()
    detectedModels?.forEach { modelObj ->
      if (modelObj is HashMap<*, *>) {
        val modelMap = Arguments.createMap()
        modelMap.putString("type", modelObj["type"] as? String ?: "")
        modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
        modelsArray.pushMap(modelMap)
      }
    }
    return modelsArray
  }
}