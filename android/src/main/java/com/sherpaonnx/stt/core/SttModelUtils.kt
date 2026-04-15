package com.sherpaonnx.stt.core

internal fun supportsHotwords(modelType: String): Boolean =
  modelType == "transducer" || modelType == "nemo_transducer"

internal fun normalizeQwen3HotwordsCsv(raw: String): String {
  if (raw.isEmpty()) return ""
  val flat = raw.replace('\r', '\n').replace('\n', ',')
  return flat.split(',')
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .joinToString(",")
}
