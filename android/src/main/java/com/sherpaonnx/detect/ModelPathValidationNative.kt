package com.sherpaonnx.detect

import com.sherpaonnx.SherpaOnnxModule

internal object ModelPathValidationNative {

  fun validate(
    category: String,
    modelType: String,
    paths: Map<String, String>
  ): String? {
    @Suppress("UNCHECKED_CAST")
    val result =
      SherpaOnnxModule.validateCustomModelPathsNative(
        category,
        modelType,
        HashMap(paths)
      ) as? HashMap<String, Any?> ?: return "Custom model path validation returned null"

    val ok = result["ok"] as? Boolean ?: false
    if (ok) return null

    val error = result["error"] as? String
    if (!error.isNullOrBlank()) return error

    @Suppress("UNCHECKED_CAST")
    val missing = result["missingRequired"] as? ArrayList<String>
    if (!missing.isNullOrEmpty()) {
      return "Missing required paths: ${missing.joinToString(", ")}"
    }
    return "Invalid custom model paths"
  }
}
