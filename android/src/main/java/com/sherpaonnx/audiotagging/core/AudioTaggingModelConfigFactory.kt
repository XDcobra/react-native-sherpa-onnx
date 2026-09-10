package com.sherpaonnx.audiotagging.core

import com.k2fsa.sherpa.onnx.AudioTaggingConfig
import com.k2fsa.sherpa.onnx.AudioTaggingModelConfig
import com.k2fsa.sherpa.onnx.OfflineZipformerAudioTaggingModelConfig

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

  fun build(
    modelType: String,
    paths: Map<String, String>,
    topK: Int,
    numThreads: Int,
    provider: String?,
    debug: Boolean,
  ): AudioTaggingConfig {
    val modelPath = paths["model"].orEmpty()
    val labelsPath = paths["labels"].orEmpty()
    if (modelPath.isBlank()) {
      throw IllegalArgumentException("Audio tagging model path is required")
    }
    if (labelsPath.isBlank()) {
      throw IllegalArgumentException("Audio tagging labels path is required")
    }

    val runtimeProvider = provider ?: "cpu"
    val modelConfig = when (modelType) {
      "ced" -> AudioTaggingModelConfig(
        ced = modelPath,
        numThreads = numThreads,
        debug = debug,
        provider = runtimeProvider,
      )
      "zipformer" -> AudioTaggingModelConfig(
        zipformer = OfflineZipformerAudioTaggingModelConfig(model = modelPath),
        numThreads = numThreads,
        debug = debug,
        provider = runtimeProvider,
      )
      else -> throw IllegalArgumentException("Unsupported audio tagging model type: $modelType")
    }

    return AudioTaggingConfig(
      model = modelConfig,
      labels = labelsPath,
      topK = topK.coerceAtLeast(1),
    )
  }
}
