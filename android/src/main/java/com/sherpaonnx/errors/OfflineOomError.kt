package com.sherpaonnx.errors

internal object OfflineOomError {
  const val CODE = "OFFLINE_OOM"

  fun message(feature: String): String =
    "Not enough memory for offline $feature. Please use a streaming mode for large inputs."
}
