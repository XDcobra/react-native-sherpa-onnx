package com.sherpaonnx.enhancement.core

import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserDpdfNetModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig

internal object EnhancementModelConfigFactory {
  fun extractModelType(result: HashMap<String, Any>, defaultType: String = "gtcrn"): String {
    return result["modelType"] as? String ?: defaultType
  }

  fun extractPaths(result: HashMap<String, Any>): Map<String, String> {
    return (result["paths"] as? Map<*, *>)
      ?.mapValues { (_, value) -> (value as? String).orEmpty() }
      ?.mapKeys { it.key.toString() }
      ?: emptyMap()
  }

  fun build(
    modelType: String,
    paths: Map<String, String>,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
  ): OfflineSpeechDenoiserModelConfig {
    val threads = numThreads?.toInt() ?: 1
    val runtimeProvider = provider ?: "cpu"
    val runtimeDebug = debug ?: false
    val modelPath = paths["model"].orEmpty()

    return when (modelType) {
      "gtcrn" -> OfflineSpeechDenoiserModelConfig(
        gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(model = modelPath),
        numThreads = threads,
        provider = runtimeProvider,
        debug = runtimeDebug,
      )

      "dpdfnet" -> OfflineSpeechDenoiserModelConfig(
        dpdfnet = OfflineSpeechDenoiserDpdfNetModelConfig(model = modelPath),
        numThreads = threads,
        provider = runtimeProvider,
        debug = runtimeDebug,
      )

      else -> throw IllegalArgumentException("Unsupported enhancement model type: $modelType")
    }
  }
}