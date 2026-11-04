package com.sherpaonnx.audiotagging.core

/** Path/type helpers for audio tagging detect results (inference uses shared C++ wrapper). */
internal object AudioTaggingModelConfigFactory {
  fun extractModelType(result: HashMap<String, Any>, defaultType: String = "ced"): String {
    return result["modelType"] as? String ?: defaultType
  }

  fun extractPaths(result: HashMap<String, Any>): Map<String, String> {
    return (result["paths"] as? Map<*, *>)
      ?.mapValues { (_, value) -> (value as? String).orEmpty() }
      ?.mapKeys { it.key.toString() }
      ?: emptyMap()
  }
}
